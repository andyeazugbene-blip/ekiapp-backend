import { ShipmentStatus } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import type { CreateShipmentInput, ListShipmentsQuery, UpdateShipmentInput } from "./shipments.types";

const SHIPMENT_STATUSES = new Set<string>(Object.values(ShipmentStatus));
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export function validateCreateShipmentInput(input: unknown): CreateShipmentInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  const trackingNumber =
    typeof raw.trackingNumber === "string" && raw.trackingNumber.trim().length > 0
      ? raw.trackingNumber.trim()
      : undefined;

  const carrier =
    typeof raw.carrier === "string" && raw.carrier.trim().length > 0
      ? raw.carrier.trim()
      : undefined;

  let estimatedDeliveryAt: string | undefined;
  if (typeof raw.estimatedDeliveryAt === "string" && raw.estimatedDeliveryAt.trim().length > 0) {
    const d = new Date(raw.estimatedDeliveryAt);
    if (isNaN(d.getTime())) {
      throw new AppError("Invalid estimatedDeliveryAt date", 400);
    }
    estimatedDeliveryAt = d.toISOString();
  }

  return { trackingNumber, carrier, estimatedDeliveryAt };
}

export function validateUpdateShipmentInput(input: unknown): UpdateShipmentInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;
  const update: UpdateShipmentInput = {};

  if (raw.trackingNumber !== undefined) {
    update.trackingNumber =
      typeof raw.trackingNumber === "string" ? raw.trackingNumber.trim() : undefined;
  }

  if (raw.carrier !== undefined) {
    update.carrier = typeof raw.carrier === "string" ? raw.carrier.trim() : undefined;
  }

  if (raw.status !== undefined) {
    if (typeof raw.status !== "string" || !SHIPMENT_STATUSES.has(raw.status)) {
      throw new AppError("Invalid shipment status", 400);
    }
    update.status = raw.status as ShipmentStatus;
  }

  if (raw.estimatedDeliveryAt !== undefined) {
    if (raw.estimatedDeliveryAt === null) {
      update.estimatedDeliveryAt = null;
    } else if (typeof raw.estimatedDeliveryAt === "string") {
      const d = new Date(raw.estimatedDeliveryAt);
      if (isNaN(d.getTime())) {
        throw new AppError("Invalid estimatedDeliveryAt date", 400);
      }
      update.estimatedDeliveryAt = d.toISOString();
    }
  }

  if (Object.keys(update).length === 0) {
    throw new AppError("No fields to update", 400);
  }

  return update;
}

export function validateListShipmentsQuery(query: Record<string, unknown>): ListShipmentsQuery {
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
      throw new AppError(`Invalid limit (1-${MAX_LIMIT})`, 400);
    }
    limit = parsed;
  }

  let status: ShipmentStatus | undefined;
  if (query.status !== undefined) {
    if (typeof query.status !== "string" || !SHIPMENT_STATUSES.has(query.status)) {
      throw new AppError("Invalid status", 400);
    }
    status = query.status as ShipmentStatus;
  }

  const cursor =
    typeof query.cursor === "string" && query.cursor.length > 0 ? query.cursor : undefined;

  return { status, limit, cursor };
}
