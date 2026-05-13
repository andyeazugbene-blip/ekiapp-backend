import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { stripeConnectService } from "./stripe-connect.service";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

export async function onboardStripeConnect(request: Request, response: Response): Promise<void> {
  const result = await stripeConnectService.onboard(requireUserId(request));
  response.status(200).json(result);
}

export async function getStripeConnectStatus(request: Request, response: Response): Promise<void> {
  const result = await stripeConnectService.getStatus(requireUserId(request));
  response.status(200).json(result);
}

export async function refreshStripeConnect(request: Request, response: Response): Promise<void> {
  const result = await stripeConnectService.refresh(requireUserId(request));
  response.status(200).json(result);
}
