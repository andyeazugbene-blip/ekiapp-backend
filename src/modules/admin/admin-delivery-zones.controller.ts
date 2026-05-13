import type { Request, Response } from "express";

import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
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
      currency: typeof raw.currency === "string" ? raw.currency.trim().toLowerCase() : env.defaultCurrency,
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
  if (raw.currency !== undefined) {
    data.currency = typeof raw.currency === "string" ? raw.currency.trim().toLowerCase() : env.defaultCurrency;
  }
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
