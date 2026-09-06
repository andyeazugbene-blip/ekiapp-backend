import type { Prisma, VendorMarketAssignment } from "@prisma/client";
import type { Request } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { currencyFromCountry, marketCodeToCountryName, resolveMarketCode } from "../../shared/currency";
import { recordAudit } from "../../shared/utils/audit";
import { marketConfigurationService } from "../community-buy/market-configuration.service";

/**
 * A vendor's PRIMARY market stays Vendor.country/Vendor.currency (every
 * existing single-country call site keeps reading those, unchanged). This
 * service is the additive layer: a vendor may hold more than one active
 * VendorMarketAssignment, each independently resolving its own currency from
 * the real per-market MarketConfiguration row — not the coarser
 * currencyFromCountry() map, which has no entry for Canada/Switzerland and
 * would silently mis-price them as EUR.
 */
async function resolveCurrencyForMarketCode(marketCode: string): Promise<string> {
  const config = await marketConfigurationService.get(marketCode);
  if (config?.currency) return config.currency;
  // Defensive only — every one of the 10 launch markets is seeded with a
  // MarketConfiguration row by marketConfigurationService.ensureDefaults().
  return currencyFromCountry(marketCodeToCountryName(marketCode) ?? marketCode);
}

/**
 * Resolve the currency for ANY raw country representation — a launch market
 * (via the real per-market MarketConfiguration.currency, which correctly
 * covers CAD/CHF) or a legacy/non-launch country (via the coarser
 * currencyFromCountry() map, same as before this module existed). Exported
 * so vendor creation uses the exact same resolution as market assignments —
 * a vendor's primary currency and their VendorMarketAssignment currency for
 * the same market never disagree.
 */
export async function resolveCurrencyForMarket(rawMarket: string | null | undefined): Promise<string> {
  const code = resolveMarketCode(rawMarket);
  if (code) return resolveCurrencyForMarketCode(code);
  return currencyFromCountry(rawMarket);
}

function assertLaunchMarketCode(rawMarket: string): string {
  const code = resolveMarketCode(rawMarket);
  if (!code) {
    throw new AppError(`"${rawMarket}" is not one of Eki's currently approved launch markets`, 400);
  }
  return code;
}

export const vendorMarketsService = {
  async listForVendor(vendorId: string): Promise<VendorMarketAssignment[]> {
    return prisma.vendorMarketAssignment.findMany({
      where: { vendorId },
      orderBy: { createdAt: "asc" },
    });
  },

  async getActiveMarketCodes(vendorId: string): Promise<string[]> {
    const rows = await prisma.vendorMarketAssignment.findMany({
      where: { vendorId, enabled: true },
      select: { marketCode: true },
    });
    return rows.map((row) => row.marketCode);
  },

  /** Backend-authoritative gate: is this vendor's assignment for this exact market active? Never trust a frontend hiding a picker instead. */
  async hasActiveMarket(vendorId: string, rawMarket: string): Promise<boolean> {
    const code = resolveMarketCode(rawMarket);
    if (!code) return false;
    const row = await prisma.vendorMarketAssignment.findUnique({
      where: { vendorId_marketCode: { vendorId, marketCode: code } },
    });
    return row?.enabled === true;
  },

  /**
   * Creates (or reactivates) one assignment without the launch-market gate —
   * used only at vendor creation and by the one-off migration backfill, both
   * of which are recording a market the vendor ALREADY has (their onboarding
   * selection, or their pre-existing Vendor.country), never granting a new
   * one a human chose through the add-market flow. A legacy vendor whose
   * stored country predates the launch-market list still gets a row (so
   * their data isn't destroyed), just under a non-canonical marketCode that
   * can never match a real launch-market gate — which is correct, since they
   * were never actually approved for one.
   */
  async ensureInitialAssignment(
    vendorId: string,
    rawMarket: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? prisma;
    const trimmed = rawMarket.trim();
    if (!trimmed) return;
    const code = resolveMarketCode(trimmed);
    const marketCode = code ?? trimmed.toUpperCase().slice(0, 64);
    const countryName = code ? (marketCodeToCountryName(code) ?? trimmed) : trimmed;
    const currency = code ? await resolveCurrencyForMarketCode(code) : currencyFromCountry(trimmed);

    await client.vendorMarketAssignment.upsert({
      where: { vendorId_marketCode: { vendorId, marketCode } },
      update: {},
      create: { vendorId, marketCode, countryName, currency, enabled: true },
    });
  },

  /** Vendor- or admin-initiated: add an approved launch market to a vendor's assignments. */
  async addMarket(params: {
    vendorId: string;
    actorId: string;
    rawMarket: string;
    request?: Request;
    reason?: string;
  }): Promise<VendorMarketAssignment> {
    const marketCode = assertLaunchMarketCode(params.rawMarket);
    const countryName = marketCodeToCountryName(marketCode)!;
    const currency = await resolveCurrencyForMarketCode(marketCode);

    const before = await prisma.vendorMarketAssignment.findUnique({
      where: { vendorId_marketCode: { vendorId: params.vendorId, marketCode } },
    });

    const row = await prisma.vendorMarketAssignment.upsert({
      where: { vendorId_marketCode: { vendorId: params.vendorId, marketCode } },
      update: { enabled: true, countryName, currency },
      create: { vendorId: params.vendorId, marketCode, countryName, currency, enabled: true },
    });

    await recordAudit({
      actorId: params.actorId,
      action: "vendor.market.add",
      entityType: "Vendor",
      entityId: params.vendorId,
      reason: params.reason,
      beforeState: before ? { marketCode: before.marketCode, enabled: before.enabled } : { marketCode: null },
      afterState: { marketCode: row.marketCode, countryName: row.countryName, currency: row.currency, enabled: row.enabled },
      request: params.request,
    });

    return row;
  },

  /** Permanently removes one market assignment. Refuses to drop a vendor's last active market. */
  async removeMarket(params: {
    vendorId: string;
    actorId: string;
    rawMarket: string;
    request?: Request;
    reason?: string;
  }): Promise<void> {
    const code = resolveMarketCode(params.rawMarket) ?? params.rawMarket.trim().toUpperCase();
    const existing = await prisma.vendorMarketAssignment.findUnique({
      where: { vendorId_marketCode: { vendorId: params.vendorId, marketCode: code } },
    });
    if (!existing) {
      throw new AppError("Vendor has no assignment for this market", 404);
    }

    if (existing.enabled) {
      const activeCount = await prisma.vendorMarketAssignment.count({
        where: { vendorId: params.vendorId, enabled: true },
      });
      if (activeCount <= 1) {
        throw new AppError("A vendor must have at least one active market — add another market before removing this one", 400);
      }
    }

    await prisma.vendorMarketAssignment.delete({ where: { id: existing.id } });

    await recordAudit({
      actorId: params.actorId,
      action: "vendor.market.remove",
      entityType: "Vendor",
      entityId: params.vendorId,
      reason: params.reason,
      beforeState: { marketCode: existing.marketCode, countryName: existing.countryName, enabled: existing.enabled },
      afterState: { marketCode: null },
      request: params.request,
    });
  },

  /** Soft enable/disable — reversible, unlike removeMarket. Refuses to disable a vendor's last active market. */
  async setEnabled(params: {
    vendorId: string;
    actorId: string;
    rawMarket: string;
    enabled: boolean;
    request?: Request;
    reason?: string;
  }): Promise<VendorMarketAssignment> {
    const code = resolveMarketCode(params.rawMarket) ?? params.rawMarket.trim().toUpperCase();
    const existing = await prisma.vendorMarketAssignment.findUnique({
      where: { vendorId_marketCode: { vendorId: params.vendorId, marketCode: code } },
    });
    if (!existing) {
      throw new AppError("Vendor has no assignment for this market", 404);
    }

    if (!params.enabled && existing.enabled) {
      const activeCount = await prisma.vendorMarketAssignment.count({
        where: { vendorId: params.vendorId, enabled: true },
      });
      if (activeCount <= 1) {
        throw new AppError("A vendor must have at least one active market — enable another market before disabling this one", 400);
      }
    }

    const row = await prisma.vendorMarketAssignment.update({
      where: { id: existing.id },
      data: { enabled: params.enabled },
    });

    await recordAudit({
      actorId: params.actorId,
      action: params.enabled ? "vendor.market.enable" : "vendor.market.disable",
      entityType: "Vendor",
      entityId: params.vendorId,
      reason: params.reason,
      beforeState: { marketCode: existing.marketCode, enabled: existing.enabled },
      afterState: { marketCode: row.marketCode, enabled: row.enabled },
      request: params.request,
    });

    return row;
  },
};
