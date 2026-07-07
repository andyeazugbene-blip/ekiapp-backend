import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { currencyFromCountry } from "../../shared/currency";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new AppError("Invalid id", 400);
  }
  return id;
}

export async function listAllDeliveryZones(_request: Request, response: Response): Promise<void> {
  const zones = await prisma.deliveryZone.findMany({
    include: { deliveryMethods: { orderBy: { priceAmount: "asc" } } },
    orderBy: { country: "asc" },
  });
  response.status(200).json({ zones });
}

export async function createDeliveryZone(request: Request, response: Response): Promise<void> {
  const raw = request.body as Record<string, unknown>;

  if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
    throw new AppError("name is required", 400);
  }
  if (typeof raw.country !== "string" || raw.country.trim().length === 0) {
    throw new AppError("country is required", 400);
  }

  const baseFeeAmount = Number(raw.baseFeeAmount);
  const feePerKgAmount = Number(raw.feePerKgAmount);
  if (!Number.isInteger(baseFeeAmount) || baseFeeAmount < 0) {
    throw new AppError("Invalid baseFeeAmount", 400);
  }
  if (!Number.isInteger(feePerKgAmount) || feePerKgAmount < 0) {
    throw new AppError("Invalid feePerKgAmount", 400);
  }

  const zone = await prisma.deliveryZone.create({
    data: {
      name: raw.name.trim(),
      country: raw.country.trim(),
      flag: typeof raw.flag === "string" ? raw.flag.trim() || null : null,
      baseFeeAmount,
      feePerKgAmount,
      // Always derive from country — never trust a client-supplied currency
      // for a delivery zone (see delivery-zones.service.ts for why).
      currency: currencyFromCountry(raw.country.trim()),
      isActive: raw.isActive !== false,
      vendorId: null, // Global zone
    },
  });

  await recordAudit({
    actorId: requireUserId(request),
    action: "delivery_zone.create",
    entityType: "DeliveryZone",
    entityId: zone.id,
    metadata: { name: zone.name, country: zone.country },
  });

  response.status(201).json({ zone });
}

export async function updateDeliveryZone(request: Request, response: Response): Promise<void> {
  const zoneId = requireIdParam(request);
  const raw = request.body as Record<string, unknown>;

  const zone = await prisma.deliveryZone.findUnique({ where: { id: zoneId } });
  if (!zone) {
    throw new AppError("Delivery zone not found", 404);
  }

  const data: Record<string, unknown> = {};
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || raw.name.trim().length === 0) throw new AppError("Invalid name", 400);
    data.name = raw.name.trim();
  }
  if (raw.country !== undefined) {
    if (typeof raw.country !== "string" || raw.country.trim().length === 0) throw new AppError("Invalid country", 400);
    data.country = raw.country.trim();
    // Currency must follow country — never accept a client-supplied currency
    // independent of it.
    data.currency = currencyFromCountry(raw.country.trim());
  }
  if (raw.flag !== undefined) {
    data.flag = raw.flag === null ? null : typeof raw.flag === "string" ? raw.flag.trim() || null : null;
  }
  if (raw.baseFeeAmount !== undefined) {
    const v = Number(raw.baseFeeAmount);
    if (!Number.isInteger(v) || v < 0) throw new AppError("Invalid baseFeeAmount", 400);
    data.baseFeeAmount = v;
  }
  if (raw.feePerKgAmount !== undefined) {
    const v = Number(raw.feePerKgAmount);
    if (!Number.isInteger(v) || v < 0) throw new AppError("Invalid feePerKgAmount", 400);
    data.feePerKgAmount = v;
  }
  // currency is intentionally not settable directly — it's always derived
  // from country above, so a delivery zone can never end up mismatched.
  if (raw.isActive !== undefined) {
    data.isActive = raw.isActive === true;
  }

  if (Object.keys(data).length === 0) {
    throw new AppError("No fields to update", 400);
  }

  const updated = await prisma.deliveryZone.update({ where: { id: zoneId }, data });

  await recordAudit({
    actorId: requireUserId(request),
    action: "delivery_zone.update",
    entityType: "DeliveryZone",
    entityId: zoneId,
    metadata: data,
  });

  response.status(200).json({ zone: updated });
}

/**
 * One-time repair for zones created before currency was locked to country.
 * Corrects any zone whose stored currency doesn't match currencyFromCountry(country).
 */
export async function fixDeliveryZoneCurrencies(request: Request, response: Response): Promise<void> {
  const zones = await prisma.deliveryZone.findMany({ select: { id: true, country: true, currency: true } });
  const corrections: { id: string; country: string; from: string; to: string }[] = [];

  for (const zone of zones) {
    const correctCurrency = currencyFromCountry(zone.country);
    if (zone.currency !== correctCurrency) {
      corrections.push({ id: zone.id, country: zone.country, from: zone.currency, to: correctCurrency });
    }
  }

  for (const fix of corrections) {
    await prisma.deliveryZone.update({ where: { id: fix.id }, data: { currency: fix.to } });
  }

  await recordAudit({
    actorId: requireUserId(request),
    action: "delivery_zone.fix_currencies",
    entityType: "DeliveryZone",
    metadata: { corrected: corrections.length, corrections },
  });

  response.status(200).json({ checked: zones.length, corrected: corrections.length, corrections });
}

export async function deleteDeliveryZone(request: Request, response: Response): Promise<void> {
  const zoneId = requireIdParam(request);

  const zone = await prisma.deliveryZone.findUnique({ where: { id: zoneId } });
  if (!zone) {
    throw new AppError("Delivery zone not found", 404);
  }

  await prisma.deliveryZone.delete({ where: { id: zoneId } });

  await recordAudit({
    actorId: requireUserId(request),
    action: "delivery_zone.delete",
    entityType: "DeliveryZone",
    entityId: zoneId,
    metadata: { name: zone.name, country: zone.country },
  });

  response.status(200).json({ success: true });
}
