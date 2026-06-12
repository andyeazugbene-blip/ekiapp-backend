import { RewardType } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import type { CreateRewardInput, UpdateRewardInput, ClaimRewardInput } from "./rewards.types";

const VALID_TYPES = new Set<string>(Object.values(RewardType));

export function validateCreateRewardInput(input: unknown): CreateRewardInput {
  if (!input || typeof input !== "object") throw new AppError("Invalid request body", 400);
  const raw = input as Record<string, unknown>;

  if (typeof raw.name !== "string" || raw.name.trim().length === 0) throw new AppError("name is required", 400);
  if (typeof raw.type !== "string" || !VALID_TYPES.has(raw.type)) throw new AppError("Invalid reward type", 400);

  const value = Number(raw.value);
  if (!Number.isInteger(value) || value <= 0) throw new AppError("value must be a positive integer", 400);

  let currency: string | undefined;
  if (typeof raw.currency === "string" && raw.currency.trim().length > 0) {
    currency = raw.currency.trim().toUpperCase();
  }

  let minOrderAmount: number | undefined;
  if (raw.minOrderAmount !== undefined) {
    const v = Number(raw.minOrderAmount);
    if (!Number.isInteger(v) || v < 0) throw new AppError("Invalid minOrderAmount", 400);
    minOrderAmount = v;
  }

  let maxClaims: number | undefined;
  if (raw.maxClaims !== undefined) {
    const v = Number(raw.maxClaims);
    if (!Number.isInteger(v) || v <= 0) throw new AppError("Invalid maxClaims", 400);
    maxClaims = v;
  }

  let expiresAt: string | undefined;
  if (typeof raw.expiresAt === "string" && raw.expiresAt.length > 0) {
    const d = new Date(raw.expiresAt);
    if (isNaN(d.getTime())) throw new AppError("Invalid expiresAt date", 400);
    expiresAt = d.toISOString();
  }

  return {
    name: raw.name.trim(),
    description: typeof raw.description === "string" ? raw.description.trim() : undefined,
    type: raw.type as RewardType,
    value,
    currency,
    minOrderAmount,
    isActive: raw.isActive === true || raw.isActive === undefined,
    maxClaims,
    expiresAt,
  };
}

export function validateUpdateRewardInput(input: unknown): UpdateRewardInput {
  if (!input || typeof input !== "object") throw new AppError("Invalid request body", 400);
  const raw = input as Record<string, unknown>;
  const update: UpdateRewardInput = {};

  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || raw.name.trim().length === 0) throw new AppError("Invalid name", 400);
    update.name = raw.name.trim();
  }
  if (raw.description !== undefined) {
    update.description = typeof raw.description === "string" ? raw.description.trim() : null;
  }
  if (raw.type !== undefined) {
    if (typeof raw.type !== "string" || !VALID_TYPES.has(raw.type)) throw new AppError("Invalid reward type", 400);
    update.type = raw.type as RewardType;
  }
  if (raw.value !== undefined) {
    const v = Number(raw.value);
    if (!Number.isInteger(v) || v <= 0) throw new AppError("Invalid value", 400);
    update.value = v;
  }
  if (raw.currency !== undefined) {
    if (typeof raw.currency !== "string" || raw.currency.trim().length === 0) throw new AppError("Invalid currency", 400);
    update.currency = raw.currency.trim().toUpperCase();
  }
  if (raw.minOrderAmount !== undefined) {
    const v = Number(raw.minOrderAmount);
    if (!Number.isInteger(v) || v < 0) throw new AppError("Invalid minOrderAmount", 400);
    update.minOrderAmount = v;
  }
  if (raw.isActive !== undefined) {
    update.isActive = raw.isActive === true;
  }
  if (raw.maxClaims !== undefined) {
    const v = Number(raw.maxClaims);
    if (!Number.isInteger(v) || v <= 0) throw new AppError("Invalid maxClaims", 400);
    update.maxClaims = v;
  }
  if (raw.expiresAt !== undefined) {
    if (raw.expiresAt === null) {
      update.expiresAt = null;
    } else if (typeof raw.expiresAt === "string") {
      const d = new Date(raw.expiresAt);
      if (isNaN(d.getTime())) throw new AppError("Invalid expiresAt date", 400);
      update.expiresAt = d.toISOString();
    }
  }

  if (Object.keys(update).length === 0) throw new AppError("No fields to update", 400);
  return update;
}

export function validateClaimRewardInput(input: unknown): ClaimRewardInput {
  if (!input || typeof input !== "object") throw new AppError("Invalid request body", 400);
  const raw = input as Record<string, unknown>;
  if (typeof raw.referralCode !== "string" || raw.referralCode.trim().length === 0) {
    throw new AppError("referralCode is required", 400);
  }
  return { referralCode: raw.referralCode.trim().toUpperCase() };
}
