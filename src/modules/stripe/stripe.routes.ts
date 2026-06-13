import { Router } from "express";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../shared/utils/async-handler";
import { releaseVendorEarnings } from "../../shared/utils/wallet-release";
import { AppError } from "../../shared/errors/app-error";
import { handleStripeWebhook } from "./stripe.controller";

export const stripeRouter = Router();

stripeRouter.get("/webhook", (_req, res) => {
  res.status(200).json({ status: "ok", message: "Stripe webhook endpoint ready" });
});

stripeRouter.post("/webhook", asyncHandler(handleStripeWebhook));

// Debug: force credit a wallet for an order (authenticate via header)
stripeRouter.post("/webhook-test", asyncHandler(async (req, res) => {
  if (req.headers["x-debug-key"] !== "eki-debug-2026") throw new AppError("Forbidden", 403);
  const orderId = req.body?.orderId;
  if (!orderId) throw new AppError("orderId required", 400);
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { payment: true, items: { select: { vendorId: true } } } });
  if (!order || !order.payment) throw new AppError("Order or payment not found", 404);
  await prisma.payment.update({ where: { id: order.payment.id }, data: { status: "SUCCEEDED", processedAt: new Date() } });
  await prisma.order.update({ where: { id: orderId }, data: { status: "PAID" } });
  const vendorId = order.vendorId ?? order.items[0]?.vendorId;
  if (!vendorId) throw new AppError("No vendor", 400);
  let wallet = await prisma.wallet.findUnique({ where: { vendorId } });
  if (!wallet) wallet = await prisma.wallet.create({ data: { vendorId, currency: order.payment.currency } });
  await prisma.walletTransaction.create({ data: { walletId: wallet.id, vendorId, orderId: order.id, paymentId: order.payment.id, type: "PAYMENT_PENDING_CREDIT", amount: order.payment.vendorEarningsAmount, currency: order.payment.currency, description: `Test credit for order ${order.id}` } });
  await prisma.wallet.update({ where: { id: wallet.id }, data: { pendingBalance: { increment: order.payment.vendorEarningsAmount } } });
  const released = await releaseVendorEarnings(orderId);
  logger.info("Test webhook: wallet credited", { orderId, vendorId, amount: order.payment.vendorEarningsAmount });
  const w2 = await prisma.wallet.findUnique({ where: { vendorId }, select: { pendingBalance: true, availableBalance: true } });
  res.json({ success: true, amount: order.payment.vendorEarningsAmount, released: released.released, pendingBalance: w2?.pendingBalance, availableBalance: w2?.availableBalance });
}));
