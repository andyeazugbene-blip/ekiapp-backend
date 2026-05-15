import { SubscriptionPlan } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import type { ActivateSubscriptionInput, CreateSubscriptionInput } from "./subscriptions.types";

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
