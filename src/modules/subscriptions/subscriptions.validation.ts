import { SubscriptionPlan } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import type {
  AssignVendorPlanInput,
  ActivateSubscriptionInput,
  CreateSubscriptionInput,
  CreateWebSubscriptionCheckoutInput,
  CommissionTierInput,
  SubscriptionPlanConfigInput,
} from "./subscriptions.types";

const PLANS = new Set<string>(Object.values(SubscriptionPlan));

export function validateCreateSubscriptionInput(input: unknown): CreateSubscriptionInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.plan !== "string" || raw.plan.trim().length === 0) {
    throw new AppError("plan is required", 400);
  }
  const plan = raw.plan.trim().toUpperCase();
  if (!PLANS.has(plan)) {
    throw new AppError("plan must be one of FREE, BASIC, GROWTH, PREMIUM, PRO", 400);
  }
  return { plan: plan as SubscriptionPlan };
}

export function validateCreateWebSubscriptionCheckoutInput(input: unknown): CreateWebSubscriptionCheckoutInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  const plan = typeof raw.plan === "string" ? raw.plan.trim() : "";
  if (!plan) {
    throw new AppError("plan is required", 400);
  }

  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError("A valid vendor email is required", 400);
  }

  return { plan, email };
}

export function validateActivateSubscriptionInput(input: unknown): ActivateSubscriptionInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;
  const planRaw = typeof raw.plan === "string" ? raw.plan.trim() : "";
  if (!planRaw) {
    throw new AppError("plan is required", 400);
  }
  const plan = planRaw.toUpperCase();
  // Only allow plans that can be activated from the app (soft-launch policy)
  const ALLOWED = new Set<string>(["FREE", "GROWTH", "PRO"]);
  if (!ALLOWED.has(plan)) {
    throw new AppError("plan must be one of FREE, GROWTH, PRO", 400);
  }
  return { plan: plan as SubscriptionPlan };
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new AppError(`${field} must be a boolean`, 400);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(`${field} is required`, 400);
  }
  return value.trim();
}

function requireInteger(value: unknown, field: string, options?: { min?: number; max?: number }): number {
  if (!Number.isInteger(value)) {
    throw new AppError(`${field} must be an integer`, 400);
  }
  const number = Number(value);
  if (options?.min !== undefined && number < options.min) {
    throw new AppError(`${field} must be at least ${options.min}`, 400);
  }
  if (options?.max !== undefined && number > options.max) {
    throw new AppError(`${field} must be at most ${options.max}`, 400);
  }
  return number;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseLegacyPlan(value: unknown): SubscriptionPlan | null {
  if (value == null || value === "") return null;
  const plan = typeof value === "string" ? value.toUpperCase() : "";
  if (!PLANS.has(plan)) {
    throw new AppError("legacy plan must be FREE, BASIC, GROWTH, PREMIUM, or PRO", 400);
  }
  return plan as SubscriptionPlan;
}

function validateCommissionTier(raw: unknown, index: number): CommissionTierInput {
  if (!raw || typeof raw !== "object") {
    throw new AppError(`commissionTiers[${index}] must be an object`, 400);
  }
  const tier = raw as Record<string, unknown>;
  const minSubtotalCents = requireInteger(tier.minSubtotalCents, `commissionTiers[${index}].minSubtotalCents`, { min: 0 });
  const maxSubtotalCents =
    tier.maxSubtotalCents == null
      ? null
      : requireInteger(tier.maxSubtotalCents, `commissionTiers[${index}].maxSubtotalCents`, { min: minSubtotalCents + 1 });

  return {
    id: typeof tier.id === "string" && tier.id.trim().length > 0 ? tier.id.trim() : undefined,
    label: optionalString(tier.label),
    minSubtotalCents,
    maxSubtotalCents,
    platformFeeBps: requireInteger(tier.platformFeeBps, `commissionTiers[${index}].platformFeeBps`, { min: 0, max: 10000 }),
    isActive: typeof tier.isActive === "boolean" ? tier.isActive : true,
    displayOrder: tier.displayOrder == null ? index : requireInteger(tier.displayOrder, `commissionTiers[${index}].displayOrder`, { min: 0 }),
  };
}

export function validateSubscriptionPlanConfigInput(input: unknown): SubscriptionPlanConfigInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }

  const raw = input as Record<string, unknown>;
  const slug = requireString(raw.slug, "slug").toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new AppError("slug must use lowercase letters, numbers, and dashes only", 400);
  }
  const commissionTiersRaw = Array.isArray(raw.commissionTiers) ? raw.commissionTiers : [];
  const commissionTiers = commissionTiersRaw.map(validateCommissionTier);
  if (!commissionTiers.some((tier) => tier.isActive && tier.minSubtotalCents === 0)) {
    throw new AppError("At least one active commission tier must start at 0", 400);
  }
  const defaultPlatformFeeBps =
    raw.defaultPlatformFeeBps == null && raw.platformFeeBps != null
      ? requireInteger(raw.platformFeeBps, "platformFeeBps", { min: 0, max: 10000 })
      : requireInteger(raw.defaultPlatformFeeBps, "defaultPlatformFeeBps", { min: 0, max: 10000 });

  return {
    id: typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : undefined,
    plan: parseLegacyPlan(raw.plan ?? raw.legacyPlan),
    slug,
    name: requireString(raw.name, "name"),
    description: typeof raw.description === "string" ? raw.description.trim() : null,
    monthlyPriceCents: requireInteger(raw.monthlyPriceCents, "monthlyPriceCents", { min: 0 }),
    platformFeeBps: defaultPlatformFeeBps,
    defaultPlatformFeeBps,
    withdrawalFeeBps: requireInteger(raw.withdrawalFeeBps, "withdrawalFeeBps", { min: 0, max: 10000 }),
    currency: requireString(raw.currency, "currency").toUpperCase(),
    stripePriceId: optionalString(raw.stripePriceId),
    stripeProductId: optionalString(raw.stripeProductId),
    maxProducts: requireInteger(raw.maxProducts, "maxProducts"),
    maxImagesPerProduct: requireInteger(raw.maxImagesPerProduct, "maxImagesPerProduct", { min: 1 }),
    maxOrders: raw.maxOrders == null ? null : requireInteger(raw.maxOrders, "maxOrders"),
    analytics: requireBoolean(raw.analytics, "analytics"),
    prioritySupport: requireBoolean(raw.prioritySupport, "prioritySupport"),
    flashSales: requireBoolean(raw.flashSales, "flashSales"),
    bundles: requireBoolean(raw.bundles, "bundles"),
    discounts: requireBoolean(raw.discounts, "discounts"),
    marketingTools: requireBoolean(raw.marketingTools, "marketingTools"),
    canReceiveOrders: requireBoolean(raw.canReceiveOrders, "canReceiveOrders"),
    isActive: requireBoolean(raw.isActive, "isActive"),
    isDefault: Boolean(raw.isDefault),
    displayOrder: requireInteger(raw.displayOrder, "displayOrder", { min: 0 }),
    commissionTiers,
  };
}

export function validateAssignVendorPlanInput(input: unknown): AssignVendorPlanInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;
  const planRaw = typeof raw.plan === "string" ? raw.plan.trim() : "";
  if (!planRaw) {
    throw new AppError("plan is required", 400);
  }
  const plan = planRaw.toUpperCase();
  if (!PLANS.has(plan)) {
    throw new AppError("plan must be one of FREE, BASIC, GROWTH, PREMIUM, PRO", 400);
  }
  return { plan: plan as SubscriptionPlan };
}
