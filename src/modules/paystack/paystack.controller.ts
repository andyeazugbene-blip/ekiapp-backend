import type { Request, Response } from "express";

import { logger } from "../../lib/logger";
import { paystack } from "../../lib/paystack";
import { AppError } from "../../shared/errors/app-error";
import { paystackService } from "./paystack.service";

/**
 * POST /api/paystack/initialize
 * Start a domestic escrow payment via Paystack.
 */
export async function initializePaystackPayment(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);

  const { cartId, deliveryAddress, deliveryCountry } = request.body as Record<string, unknown>;

  if (!deliveryAddress || typeof deliveryAddress !== "string") {
    throw new AppError("deliveryAddress is required", 400);
  }
  if (!deliveryCountry || typeof deliveryCountry !== "string") {
    throw new AppError("deliveryCountry is required", 400);
  }

  const result = await paystackService.initializeEscrowCheckout(request.user.id, {
    cartId: typeof cartId === "string" ? cartId : "",
    deliveryAddress: deliveryAddress.trim(),
    deliveryCountry: deliveryCountry.trim(),
  });

  response.status(201).json(result);
}

/**
 * POST /api/paystack/webhook
 * Receive Paystack webhook events.
 */
export async function handlePaystackWebhook(request: Request, response: Response): Promise<void> {
  const signature = request.headers["x-paystack-signature"];

  if (!signature || typeof signature !== "string") {
    throw new AppError("Missing signature", 400);
  }

  // Verify signature
  const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from(JSON.stringify(request.body));
  if (!paystack.verifyWebhookSignature(rawBody, signature)) {
    throw new AppError("Invalid signature", 400);
  }

  const event = JSON.parse(rawBody.toString()) as { event: string; data: Record<string, unknown> };
  logger.info("Paystack webhook received", { event: event.event });

  if (event.event === "charge.success") {
    const reference = event.data.reference as string;
    if (reference) {
      await paystackService.handleChargeSuccess(reference, event.data);
    }
  }

  // Always return 200 to Paystack
  response.status(200).json({ received: true });
}

/**
 * GET /api/paystack/verify/:reference
 * Manual verification fallback for mobile.
 */
export async function verifyPaystackPayment(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);

  const reference = String(request.params.reference ?? "").trim();
  if (!reference) throw new AppError("Reference required", 400);

  const result = await paystackService.verifyTransaction(reference, request.user.id);
  response.status(200).json(result);
}
