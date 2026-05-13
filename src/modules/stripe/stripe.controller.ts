import type { Request, Response } from "express";

import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { stripeWebhookService } from "./stripe.service";

export async function handleStripeWebhook(request: Request, response: Response): Promise<void> {
  const signature = request.headers["stripe-signature"];

  if (!signature || Array.isArray(signature)) {
    logger.warn("Stripe webhook rejected: missing stripe-signature header");
    throw new AppError("Invalid signature", 400);
  }

  if (!Buffer.isBuffer(request.body)) {
    logger.warn("Stripe webhook rejected: raw request body was not provided");
    throw new AppError("Invalid webhook payload", 400);
  }

  logger.info("Stripe webhook received", {
    bodyBytes: request.body.length,
  });

  const result = await stripeWebhookService.handleWebhook({
    signature,
    rawBody: request.body,
  });

  logger.info("Stripe webhook handled", {
    eventId: result.eventId,
    type: result.type,
    duplicate: result.duplicate ?? false,
    ignored: result.ignored ?? false,
  });

  // Only return { received: true } to Stripe — never leak internal state
  response.status(200).json({ received: true });
}
