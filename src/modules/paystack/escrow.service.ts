import crypto from "crypto";

import { prisma } from "../../lib/prisma";
import { paystack } from "../../lib/paystack";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";

const VENDOR_TIMEOUT_HOURS = Number(process.env.ESCROW_VENDOR_TIMEOUT_HOURS ?? "48");
const AUTO_RELEASE_HOURS = Number(process.env.ESCROW_AUTO_RELEASE_HOURS ?? "24");
const OTP_MAX_ATTEMPTS = 5;

export const escrowService = {
  /**
   * Vendor confirms an escrow order — transitions PAYMENT_SECURED → VENDOR_CONFIRMED.
   */
  async vendorConfirmOrder(userId: string, orderId: string): Promise<{ status: string }> {
    const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
    if (!vendor) throw new AppError("Vendor profile required", 403);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, vendorId: true, status: true, escrowType: true, buyerId: true, orderNumber: true },
    });

    if (!order) throw new AppError("Order not found", 404);
    if (order.vendorId !== vendor.id) throw new AppError("Forbidden", 403);
    if (order.escrowType !== "DOMESTIC_AFRICA") throw new AppError("Not an escrow order", 400);
    if (order.status !== "PAYMENT_SECURED") {
      throw new AppError(`Cannot confirm order in ${order.status} status. Must be PAYMENT_SECURED.`, 400);
    }

    await prisma.order.update({
      where: { id: orderId },
      data: { status: "VENDOR_CONFIRMED", vendorConfirmedAt: new Date() },
    });

    // Notify buyer
    await notificationsService.enqueue({
      userId: order.buyerId,
      type: "ORDER_PAID",
      title: "Order Confirmed",
      body: `Your order ${order.orderNumber} has been confirmed by the vendor and is being prepared.`,
      data: { orderId },
    });

    logger.info("Escrow: vendor confirmed order", { orderId, vendorId: vendor.id });
    return { status: "VENDOR_CONFIRMED" };
  },

  /**
   * Background job: auto-cancel orders where vendor didn't confirm within timeout.
   * Called every 15 minutes by the worker.
   */
  async processVendorTimeouts(): Promise<number> {
    const cutoff = new Date(Date.now() - VENDOR_TIMEOUT_HOURS * 60 * 60 * 1000);

    // Find escrow orders in PAYMENT_SECURED older than timeout
    const expiredOrders = await prisma.order.findMany({
      where: {
        escrowType: "DOMESTIC_AFRICA",
        status: "PAYMENT_SECURED",
        createdAt: { lt: cutoff },
      },
      select: {
        id: true,
        buyerId: true,
        orderNumber: true,
        totalAmount: true,
        currency: true,
        paystackTransaction: { select: { reference: true } },
        items: { select: { productId: true, quantity: true } },
      },
    });

    if (expiredOrders.length === 0) return 0;

    let processed = 0;

    for (const order of expiredOrders) {
      try {
        await prisma.$transaction(async (tx) => {
          // Cancel the order
          await tx.order.update({
            where: { id: order.id },
            data: { status: "CANCELLED" },
          });

          // Restore stock
          for (const item of order.items) {
            await tx.product.update({
              where: { id: item.productId },
              data: { stock: { increment: item.quantity } },
            });
          }
        });

        // Refund via Paystack (outside transaction — external API call)
        if (order.paystackTransaction?.reference) {
          try {
            await paystack.refundTransaction(order.paystackTransaction.reference);
            await prisma.paystackTransaction.update({
              where: { reference: order.paystackTransaction.reference },
              data: { status: "REVERSED" },
            });
          } catch (refundError) {
            logger.error("Escrow timeout: Paystack refund failed", {
              orderId: order.id,
              reference: order.paystackTransaction.reference,
              error: refundError instanceof Error ? refundError.message : String(refundError),
            });
            // Continue — order is cancelled, refund can be retried manually
          }
        }

        // Notify buyer
        await notificationsService.enqueue({
          userId: order.buyerId,
          type: "ORDER_PAID",
          title: "Order Cancelled — Refund Issued",
          body: `Order ${order.orderNumber} was cancelled because the vendor did not confirm within ${VENDOR_TIMEOUT_HOURS} hours. A full refund has been issued.`,
          data: { orderId: order.id },
        });

        processed++;
        logger.info("Escrow timeout: order cancelled and refunded", { orderId: order.id });
      } catch (error) {
        logger.error("Escrow timeout: failed to process order", {
          orderId: order.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return processed;
  },

  // ─── Batch 3: Dispatch & Delivery OTP ─────────────────────────────────

  /**
   * Vendor marks order as dispatched. Generates a one-time 6-digit OTP.
   * The plain code is returned ONLY in this response — never stored or logged.
   */
  async vendorDispatchOrder(
    userId: string,
    orderId: string,
  ): Promise<{ status: string; deliveryCode: string; expiresAt: Date }> {
    const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
    if (!vendor) throw new AppError("Vendor profile required", 403);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, vendorId: true, status: true, escrowType: true, buyerId: true, orderNumber: true },
    });

    if (!order) throw new AppError("Order not found", 404);
    if (order.vendorId !== vendor.id) throw new AppError("Forbidden", 403);
    if (order.escrowType !== "DOMESTIC_AFRICA") throw new AppError("Not an escrow order", 400);
    if (order.status !== "VENDOR_CONFIRMED") {
      throw new AppError(`Cannot dispatch order in ${order.status} status. Must be VENDOR_CONFIRMED.`, 400);
    }

    // Generate cryptographically secure 6-digit code
    const code = String(crypto.randomInt(100000, 999999));
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const expiresAt = new Date(Date.now() + AUTO_RELEASE_HOURS * 60 * 60 * 1000);

    await prisma.$transaction(async (tx) => {
      // Create DeliveryOtp (only hash stored)
      await tx.deliveryOtp.create({
        data: {
          orderId,
          codeHash,
          expiresAt,
        },
      });

      // Update order status
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: "DISPATCHED",
          escrowExpiresAt: expiresAt,
        },
      });
    });

    // Notify buyer (do NOT include the code — it's told verbally by rider)
    await notificationsService.enqueue({
      userId: order.buyerId,
      type: "ORDER_PAID",
      title: "Your order is on the way! 🚚",
      body: `Order ${order.orderNumber} has been dispatched. The rider will give you a delivery code to confirm receipt.`,
      data: { orderId },
    });

    logger.info("Escrow: order dispatched, OTP generated", { orderId });

    // Return the plain code — vendor shows it to rider. Never logged.
    return { status: "DISPATCHED", deliveryCode: code, expiresAt };
  },

  /**
   * Buyer enters the delivery OTP to confirm receipt.
   * On success: order → COMPLETED, payment released, trust +2.
   */
  async buyerConfirmDelivery(
    buyerId: string,
    orderId: string,
    code: string,
  ): Promise<{ confirmed: boolean }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, buyerId: true, status: true, escrowType: true, vendorId: true, orderNumber: true },
    });

    if (!order) throw new AppError("Order not found", 404);
    if (order.buyerId !== buyerId) throw new AppError("Forbidden", 403);
    if (order.escrowType !== "DOMESTIC_AFRICA") throw new AppError("Not an escrow order", 400);
    if (order.status !== "DISPATCHED") {
      throw new AppError(`Cannot confirm delivery for order in ${order.status} status`, 400);
    }

    const otp = await prisma.deliveryOtp.findUnique({ where: { orderId } });
    if (!otp) throw new AppError("No delivery code found for this order", 400);

    // Check expiry
    if (otp.expiresAt < new Date()) {
      throw new AppError("Delivery code has expired", 400);
    }

    // Check already confirmed
    if (otp.confirmedAt) {
      throw new AppError("Delivery already confirmed", 409);
    }

    // Check attempts
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      throw new AppError("Too many attempts. Contact support.", 429);
    }

    // Increment attempts
    await prisma.deliveryOtp.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });

    // Verify hash
    const inputHash = crypto.createHash("sha256").update(code).digest("hex");
    if (inputHash !== otp.codeHash) {
      const remaining = OTP_MAX_ATTEMPTS - otp.attempts - 1;
      throw new AppError(
        `Incorrect delivery code. ${remaining > 0 ? `${remaining} attempts remaining.` : "No attempts remaining."}`,
        400,
      );
    }

    // Success — mark confirmed, complete order, credit trust
    await prisma.$transaction(async (tx) => {
      await tx.deliveryOtp.update({
        where: { id: otp.id },
        data: { confirmedAt: new Date() },
      });

      await tx.order.update({
        where: { id: orderId },
        data: { status: "COMPLETED", deliveredAt: new Date() },
      });

      // Buyer trust +2
      await tx.user.update({
        where: { id: buyerId },
        data: { trustScore: { increment: 2 } },
      });
    });

    // Notify vendor: payment will be released
    if (order.vendorId) {
      const vendor = await prisma.vendor.findUnique({ where: { id: order.vendorId }, select: { userId: true } });
      if (vendor) {
        await notificationsService.enqueue({
          userId: vendor.userId,
          type: "BALANCE_CREDITED",
          title: "Delivery Confirmed ✅",
          body: `Order ${order.orderNumber} delivery confirmed. Payment will be released to your account.`,
          data: { orderId },
        });
      }
    }

    logger.info("Escrow: delivery confirmed via OTP", { orderId, buyerId });

    // Initiate payout to vendor (fire-and-forget)
    this.initiateVendorPayout(orderId).catch((err) => {
      logger.error("Post-OTP payout initiation failed", { orderId, error: String(err) });
    });

    return { confirmed: true };
  },

  // ─── Batch 4: 24-Hour Auto-Release ────────────────────────────────────

  /**
   * Background job: auto-release payment for dispatched orders where the
   * 24-hour window has expired without buyer action or dispute.
   */
  async processAutoReleases(): Promise<number> {
    const now = new Date();

    const expiredOrders = await prisma.order.findMany({
      where: {
        escrowType: "DOMESTIC_AFRICA",
        status: "DISPATCHED",
        escrowExpiresAt: { lt: now },
      },
      select: {
        id: true,
        buyerId: true,
        vendorId: true,
        orderNumber: true,
        totalAmount: true,
        vendorEarnings: true,
        currency: true,
      },
    });

    if (expiredOrders.length === 0) return 0;

    let processed = 0;

    for (const order of expiredOrders) {
      try {
        await prisma.$transaction(async (tx) => {
          // Mark order AUTO_RELEASED/COMPLETED
          await tx.order.update({
            where: { id: order.id },
            data: { status: "COMPLETED", autoReleasedAt: now, deliveredAt: now },
          });

          // Buyer trust -1 (went silent)
          await tx.user.update({
            where: { id: order.buyerId },
            data: { trustScore: { decrement: 1 } },
          });
        });

        // Notify vendor
        if (order.vendorId) {
          const vendor = await prisma.vendor.findUnique({ where: { id: order.vendorId }, select: { userId: true } });
          if (vendor) {
            await notificationsService.enqueue({
              userId: vendor.userId,
              type: "BALANCE_CREDITED",
              title: "Payment Auto-Released 💰",
              body: `Order ${order.orderNumber} — payment of ${order.vendorEarnings / 100} ${order.currency} has been released (24h window expired).`,
              data: { orderId: order.id },
            });
          }
        }

        processed++;
        logger.info("Escrow auto-release: completed", { orderId: order.id });

        // Initiate payout (fire-and-forget)
        this.initiateVendorPayout(order.id).catch((err) => {
          logger.error("Auto-release payout initiation failed", { orderId: order.id, error: String(err) });
        });
      } catch (error) {
        logger.error("Escrow auto-release: failed", {
          orderId: order.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return processed;
  },

  // ─── Vendor Bank Account Management ────────────────────────────────────

  /**
   * Register a vendor bank account and create a Paystack transfer recipient.
   */
  async registerBankAccount(
    userId: string,
    input: { bankCode: string; accountNumber: string; currency?: string },
  ): Promise<{ id: string; bankName: string; accountName: string; accountNumber: string }> {
    if (!paystack.isConfigured()) {
      throw new AppError("Paystack is not configured", 503);
    }

    const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true, storeName: true } });
    if (!vendor) throw new AppError("Vendor profile required", 403);

    const currency = (input.currency ?? "NGN").toUpperCase();

    // Resolve account name from Paystack
    const resolved = await paystack.resolveAccountNumber(input.accountNumber, input.bankCode);

    // Create transfer recipient on Paystack
    const recipient = await paystack.createTransferRecipient({
      name: resolved.account_name,
      accountNumber: input.accountNumber,
      bankCode: input.bankCode,
      currency,
    });

    // Unset any existing default for this vendor
    await prisma.vendorBankAccount.updateMany({
      where: { vendorId: vendor.id, isDefault: true },
      data: { isDefault: false },
    });

    // Store in DB
    const account = await prisma.vendorBankAccount.create({
      data: {
        vendorId: vendor.id,
        bankName: resolved.account_name, // Will be overwritten below
        bankCode: input.bankCode,
        accountNumber: input.accountNumber,
        accountName: resolved.account_name,
        currency,
        isDefault: true,
        paystackRecipientCode: recipient.recipient_code,
      },
    });

    logger.info("Vendor bank account registered", { vendorId: vendor.id, accountId: account.id });

    return {
      id: account.id,
      bankName: input.bankCode, // Frontend maps code to name
      accountName: resolved.account_name,
      accountNumber: input.accountNumber,
    };
  },

  /**
   * List vendor's registered bank accounts.
   */
  async listBankAccounts(userId: string): Promise<Array<{
    id: string;
    bankCode: string;
    accountNumber: string;
    accountName: string;
    currency: string;
    isDefault: boolean;
  }>> {
    const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
    if (!vendor) throw new AppError("Vendor profile required", 403);

    const accounts = await prisma.vendorBankAccount.findMany({
      where: { vendorId: vendor.id },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
      select: { id: true, bankCode: true, accountNumber: true, accountName: true, currency: true, isDefault: true },
    });

    return accounts;
  },

  /**
   * Initiate Paystack Transfer to vendor's default bank account.
   * Called after OTP confirmation or auto-release.
   */
  async initiateVendorPayout(orderId: string): Promise<void> {
    if (!paystack.isConfigured()) {
      logger.warn("Paystack payout skipped — not configured", { orderId });
      return;
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, vendorId: true, vendorEarnings: true, currency: true, orderNumber: true },
    });

    if (!order || !order.vendorId) return;

    // Find default bank account
    const bankAccount = await prisma.vendorBankAccount.findFirst({
      where: { vendorId: order.vendorId, isDefault: true },
      select: { paystackRecipientCode: true },
    });

    if (!bankAccount?.paystackRecipientCode) {
      logger.warn("Vendor payout skipped — no bank account with recipient code", { orderId, vendorId: order.vendorId });
      return;
    }

    const reference = `eki-payout-${orderId}-${Date.now().toString(36)}`;

    try {
      await paystack.initiateTransfer({
        amount: order.vendorEarnings,
        recipientCode: bankAccount.paystackRecipientCode,
        reference,
        reason: `Payout for order ${order.orderNumber}`,
      });
      logger.info("Paystack transfer initiated", { orderId, amount: order.vendorEarnings, reference });
    } catch (error) {
      logger.error("Paystack transfer failed", {
        orderId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw — payout failures are logged for manual resolution
    }
  },
};
