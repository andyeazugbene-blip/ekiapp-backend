import { PayoutRequestStatus } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import type {
  CreatePayoutRequestInput,
  ListPayoutRequestsQuery,
  RejectPayoutRequestInput,
} from "./payouts.types";

const STATUSES = new Set<string>(Object.values(PayoutRequestStatus));

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AppError(`Invalid ${field}`, 400);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function validateCreatePayoutRequestInput(input: unknown): CreatePayoutRequestInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.payoutMethodId !== "string" || raw.payoutMethodId.trim().length === 0) {
    throw new AppError("Invalid payoutMethodId", 400);
  }

  const amount = Number(raw.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new AppError("Invalid amount", 400);
  }

  return {
    payoutMethodId: raw.payoutMethodId.trim(),
    amount,
    notes: optionalString(raw.notes, "notes"),
  };
}

export function validateRejectPayoutRequestInput(input: unknown): RejectPayoutRequestInput {
  if (input === undefined || input === null) {
    return {};
  }
  if (typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;
  return {
    reason: optionalString(raw.reason, "reason"),
  };
}

export function validateListPayoutRequestsQuery(
  query: Record<string, unknown>,
): ListPayoutRequestsQuery {
  const status = query.status;
  if (status === undefined) return {};
  if (typeof status !== "string" || !STATUSES.has(status)) {
    throw new AppError("Invalid status", 400);
  }
  return { status: status as PayoutRequestStatus };
}
