import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { subscriptionsService } from "./subscriptions.service";
import { validateActivateSubscriptionInput, validateCreateSubscriptionInput } from "./subscriptions.validation";
import { PLAN_LIMITS } from "./subscriptions.types";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

export async function getSubscription(request: Request, response: Response): Promise<void> {
  const subscription = await subscriptionsService.getSubscription(requireUserId(request));
  response.status(200).json({ subscription });
}

export async function getPlans(_request: Request, response: Response): Promise<void> {
  const plans = Object.entries(PLAN_LIMITS).map(([key, limits]) => ({
    plan: key,
    ...limits,
  }));
  response.status(200).json({ plans });
}

export async function activateSubscription(request: Request, response: Response): Promise<void> {
  const input = validateActivateSubscriptionInput(request.body);
  const result = await subscriptionsService.activatePlan(requireUserId(request), input);
  response.status(200).json(result);
}

export async function createCheckoutSession(request: Request, response: Response): Promise<void> {
  const input = validateCreateSubscriptionInput(request.body);
  const result = await subscriptionsService.createCheckoutSession(requireUserId(request), input.plan);
  response.status(200).json(result);
}

export async function cancelSubscription(request: Request, response: Response): Promise<void> {
  const subscription = await subscriptionsService.cancelSubscription(requireUserId(request));
  response.status(200).json({ subscription });
}

export async function getPlanLimits(request: Request, response: Response): Promise<void> {
  const result = await subscriptionsService.getPlanLimits(requireUserId(request));
  response.status(200).json(result);
}
