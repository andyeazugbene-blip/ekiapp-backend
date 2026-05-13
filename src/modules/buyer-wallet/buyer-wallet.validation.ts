import { AppError } from "../../shared/errors/app-error";
import type { ApplyWalletInput, ListWalletTransactionsQuery, TopUpInput } from "./buyer-wallet.types";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export function validateTopUpInput(input: unknown): TopUpInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  const amount = Number(raw.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new AppError("Amount must be a positive integer (cents)", 400);
  }

  return { amount };
}

export function validateApplyWalletInput(input: unknown): ApplyWalletInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  const amount = Number(raw.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new AppError("Amount must be a positive integer (cents)", 400);
  }

  if (typeof raw.orderId !== "string" || raw.orderId.trim().length === 0) {
    throw new AppError("orderId is required", 400);
  }

  return { amount, orderId: raw.orderId.trim() };
}

export function validateListWalletTransactionsQuery(query: Record<string, unknown>): ListWalletTransactionsQuery {
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
      throw new AppError(`Invalid limit (1-${MAX_LIMIT})`, 400);
    }
    limit = parsed;
  }
  const cursor =
    typeof query.cursor === "string" && query.cursor.length > 0 ? query.cursor : undefined;
  return { limit, cursor };
}
