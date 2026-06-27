import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { subscriptionsService } from "./subscriptions.service";
import {
  validateActivateSubscriptionInput,
  validateAssignVendorPlanInput,
  validateCreateSubscriptionInput,
  validateCreateWebSubscriptionCheckoutInput,
  validateSubscriptionPlanConfigInput,
} from "./subscriptions.validation";

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
  const plans = await subscriptionsService.listPublicPlans();
  response.status(200).json({ plans });
}

export async function listAdminPlans(_request: Request, response: Response): Promise<void> {
  const plans = await subscriptionsService.listAdminPlans();
  response.status(200).json({ plans });
}

export async function upsertAdminPlan(request: Request, response: Response): Promise<void> {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }

  const input = validateSubscriptionPlanConfigInput(request.body);
  const plan = await subscriptionsService.upsertPlanConfig(request.user.id, input);
  response.status(200).json({ plan });
}

export async function deleteAdminPlan(request: Request, response: Response): Promise<void> {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }

  const planId = request.params.id ?? request.params.plan;
  if (!planId || typeof planId !== "string") {
    throw new AppError("Plan id is required and must be a string", 400);
  }

  const plan = await subscriptionsService.deletePlanConfig(request.user.id, planId);
  response.status(200).json({ plan });
}

export async function assignVendorPlan(request: Request, response: Response): Promise<void> {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }

  const vendorId = request.params.id;
  if (!vendorId || typeof vendorId !== "string") {
    throw new AppError("Vendor id is required and must be a string", 400);
  }

  const input = validateAssignVendorPlanInput(request.body);
  const subscription = await subscriptionsService.assignVendorPlan(request.user.id, vendorId, input);
  response.status(200).json({ subscription });
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

export async function createWebCheckoutSession(request: Request, response: Response): Promise<void> {
  const input = validateCreateWebSubscriptionCheckoutInput(request.body);
  const result = await subscriptionsService.createWebCheckoutSession(input.email, input.plan);
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

export async function getVendorAccount(request: Request, response: Response): Promise<void> {
  const account = await subscriptionsService.getVendorAccount(requireUserId(request));
  response.status(200).json({ account });
}
