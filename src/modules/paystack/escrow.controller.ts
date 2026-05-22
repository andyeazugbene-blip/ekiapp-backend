import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { escrowService } from "./escrow.service";

/**
 * POST /api/vendors/me/orders/:id/confirm-escrow
 * Vendor confirms a PAYMENT_SECURED escrow order.
 */
export async function vendorConfirmEscrowOrder(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const orderId = String(request.params.id ?? "");
  if (!orderId) throw new AppError("Order ID required", 400);

  const result = await escrowService.vendorConfirmOrder(request.user.id, orderId);
  response.status(200).json(result);
}

/**
 * POST /api/vendors/me/orders/:id/dispatch
 * Vendor marks order dispatched. Returns the delivery OTP code (shown once).
 */
export async function vendorDispatchOrder(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const orderId = String(request.params.id ?? "");
  if (!orderId) throw new AppError("Order ID required", 400);

  const result = await escrowService.vendorDispatchOrder(request.user.id, orderId);
  response.status(200).json(result);
}

/**
 * POST /api/orders/:id/confirm-delivery
 * Buyer enters the 6-digit OTP to confirm they received the goods.
 */
export async function buyerConfirmDelivery(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const orderId = String(request.params.id ?? "");
  if (!orderId) throw new AppError("Order ID required", 400);

  const { code } = request.body as Record<string, unknown>;
  if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
    throw new AppError("code must be a 6-digit number", 400);
  }

  const result = await escrowService.buyerConfirmDelivery(request.user.id, orderId, code.trim());
  response.status(200).json(result);
}

/**
 * POST /api/vendors/me/bank-accounts
 * Register a bank account for Paystack payouts.
 */
export async function registerBankAccount(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);

  const { bankCode, accountNumber, currency } = request.body as Record<string, unknown>;
  if (typeof bankCode !== "string" || !bankCode.trim()) throw new AppError("bankCode is required", 400);
  if (typeof accountNumber !== "string" || !accountNumber.trim()) throw new AppError("accountNumber is required", 400);

  const result = await escrowService.registerBankAccount(request.user.id, {
    bankCode: bankCode.trim(),
    accountNumber: accountNumber.trim(),
    currency: typeof currency === "string" ? currency.trim() : undefined,
  });

  response.status(201).json(result);
}

/**
 * GET /api/vendors/me/bank-accounts
 * List vendor's registered bank accounts.
 */
export async function listBankAccounts(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const accounts = await escrowService.listBankAccounts(request.user.id);
  response.status(200).json({ accounts });
}
