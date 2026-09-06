import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { vendorMarketsService } from "./vendor-markets.service";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

async function requireOwnVendorId(request: Request): Promise<string> {
  const userId = requireUserId(request);
  const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
  if (!vendor) {
    throw new AppError("Vendor profile not found", 404);
  }
  return vendor.id;
}

function requireMarketBody(request: Request): string {
  const market = (request.body as Record<string, unknown> | undefined)?.market;
  if (typeof market !== "string" || market.trim().length === 0) {
    throw new AppError("market is required", 400);
  }
  return market;
}

function requireMarketParam(request: Request): string {
  const market = request.params.marketCode;
  if (typeof market !== "string" || market.trim().length === 0) {
    throw new AppError("Invalid market", 400);
  }
  return market;
}

export async function listOwnVendorMarkets(request: Request, response: Response): Promise<void> {
  const vendorId = await requireOwnVendorId(request);
  const markets = await vendorMarketsService.listForVendor(vendorId);
  response.status(200).json({ markets });
}

export async function addOwnVendorMarket(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const vendorId = await requireOwnVendorId(request);
  const market = await vendorMarketsService.addMarket({
    vendorId,
    actorId: userId,
    rawMarket: requireMarketBody(request),
    request,
  });
  response.status(201).json({ market });
}

export async function setOwnVendorMarketEnabled(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const vendorId = await requireOwnVendorId(request);
  const enabled = (request.body as Record<string, unknown> | undefined)?.enabled;
  if (typeof enabled !== "boolean") {
    throw new AppError("enabled must be a boolean", 400);
  }
  const market = await vendorMarketsService.setEnabled({
    vendorId,
    actorId: userId,
    rawMarket: requireMarketParam(request),
    enabled,
    request,
  });
  response.status(200).json({ market });
}

export async function removeOwnVendorMarket(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const vendorId = await requireOwnVendorId(request);
  await vendorMarketsService.removeMarket({
    vendorId,
    actorId: userId,
    rawMarket: requireMarketParam(request),
    request,
  });
  response.status(200).json({ message: "Market removed" });
}
