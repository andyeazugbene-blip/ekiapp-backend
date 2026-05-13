import { SubscriptionPlan } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import type { CreateSubscriptionInput } from "./subscriptions.types";

const PLANS = new Set<string>(Object.values(SubscriptionPlan));

export function validateCreateSubscriptionInput(input: unknown): CreateSubscriptionInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.plan !== "string" || !PLANS.has(raw.plan)) {
    throw new AppError("plan must be FREE, BASIC, or PREMIUM", 400);
  }

  return { plan: raw.plan as SubscriptionPlan };
}
