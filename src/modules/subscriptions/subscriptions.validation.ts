import { SubscriptionPlan } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import type {
  ActivateSubscriptionInput,
  CreateSubscriptionInput,
  SubscriptionPlanConfigInput,
} from "./subscriptions.types";

const PLANS = new Set<string>(Object.values(SubscriptionPlan));
const ACTIVATE_PLANS = new Set(["FREE", "GROWTH", "PRO"]);

export function validateCreateSubscriptionInput(input: unknown): CreateSubscriptionInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.plan !== "string" || !PLANS.has(raw.plan)) {
    throw new AppError("plan must be FREE, BASIC, GROWTH, PREMIUM, or PRO", 400);
  }

  return { plan: raw.plan as SubscriptionPlan };
}

export function validateActivateSubscriptionInput(input: unknown): ActivateSubscriptionInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  const plan = typeof raw.plan === "string" ? raw.plan.toUpperCase() : "";
  if (!ACTIVATE_PLANS.has(plan)) {
    throw new AppError("plan must be free, growth, or pro", 400);
  }

  return { plan: plan as ActivateSubscriptionInput["plan"] };
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

export function validateSubscriptionPlanConfigInput(input: unknown): SubscriptionPlanConfigInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }

  const raw = input as Record<string, unknown>;
  const plan = typeof raw.plan === "string" ? raw.plan.toUpperCase() : "";
  if (!PLANS.has(plan)) {
    throw new AppError("plan must be FREE, BASIC, GROWTH, PREMIUM, or PRO", 400);
  }

  const slug = requireString(raw.slug, "slug").toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new AppError("slug must use lowercase letters, numbers, and dashes only", 400);
  }

  return {
    plan: plan as SubscriptionPlan,
    slug,
    name: requireString(raw.name, "name"),
    description: typeof raw.description === "string" ? raw.description.trim() : null,
    monthlyPriceCents: requireInteger(raw.monthlyPriceCents, "monthlyPriceCents", { min: 0 }),
    platformFeeBps: requireInteger(raw.platformFeeBps, "platformFeeBps", { min: 0, max: 10000 }),
    currency: requireString(raw.currency, "currency").toUpperCase(),
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
    displayOrder: requireInteger(raw.displayOrder, "displayOrder", { min: 0 }),
  };
}
