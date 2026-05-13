import { OrderStatus } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import type { ListBuyerOrdersQuery, ListVendorOrdersQuery, UpdateOrderStatusInput } from "./orders.types";

const ORDER_STATUSES = new Set<string>(Object.values(OrderStatus));
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AppError(`Invalid ${field}`, 400);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function validateListBuyerOrdersQuery(query: Record<string, unknown>): ListBuyerOrdersQuery {
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
      throw new AppError(`Invalid limit (1-${MAX_LIMIT})`, 400);
    }
    limit = parsed;
  }

  let status: OrderStatus | undefined;
  if (query.status !== undefined) {
    if (typeof query.status !== "string" || !ORDER_STATUSES.has(query.status)) {
      throw new AppError("Invalid status", 400);
    }
    status = query.status as OrderStatus;
  }

  return {
    status,
    limit,
    cursor: optionalString(query.cursor, "cursor"),
  };
}

export function validateListVendorOrdersQuery(query: Record<string, unknown>): ListVendorOrdersQuery {
  return validateListBuyerOrdersQuery(query) as ListVendorOrdersQuery;
}

export function validateUpdateOrderStatusInput(input: unknown): UpdateOrderStatusInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.status !== "string" || !ORDER_STATUSES.has(raw.status)) {
    throw new AppError("Invalid status", 400);
  }

  return { status: raw.status as OrderStatus };
}
