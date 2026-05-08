import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { stripeWebhookService } from "./stripe.service";

export async function handleStripeWebhook(request: Request, response: Response): Promise<void> {
  const signature = request.headers["stripe-signature"];

  if (!signature || Array.isArray(signature)) {
    console.warn("Stripe webhook rejected: missing stripe-signature header");
    throw new AppError("Invalid signature", 400);
  }

  if (!Buffer.isBuffer(request.body)) {
    console.warn("Stripe webhook rejected: raw request body was not provided");
    throw new AppError("Invalid webhook payload", 400);
  }

  const result = await stripeWebhookService.handleWebhook({
    signature,
    rawBody: request.body,
  });

  response.status(200).json(result);
}
