import crypto from "crypto";

import { prisma } from "../../lib/prisma";
import { paystack } from "../../lib/paystack";
import { logger } from "../../lib/logger";
import { sendSms } from "../../lib/sms";
import { AppError } from "../../shared/errors/app-error";
import { releaseVendorEarnings } from "../../shared/utils/wallet-release";
import { notificationsService } from "../notifications/notifications.service";

const VENDOR_TIMEOUT_HOURS = Number(process.env.ESCROW_VENDOR_TIMEOUT_HOURS ?? "48");
const AUTO_RELEASE_HOURS = Number(process.env.ESCROW_AUTO_RELEASE_HOURS ?? "24");
const OTP_MAX_ATTEMPTS = 5;

function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.replace(/\s+/g, "");
  if (trimmed.length <= 4) return trimmed;
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-2)}`;
}

export const escrowService = {
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

  async processVendorTimeouts(): Promise<number> {
    const cutoff = new Date(Date.now() - VENDOR_TIMEOUT_HOURS * 60 * 60 * 1000);

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
          await tx.order.update({
            where: { id: order.id },
            data: { status: "CANCELLED" },
          });

          for (const item of order.items) {
            await tx.product.update({
              where: { id: item.productId },
              data: { stock: { increment: item.quantity } },
            });
          }
        });

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
          }
        }

        await notificationsService.enqueue({
          userId: order.buyerId,
          type: "ORDER_PAID",
          title: "Order Cancelled - Refund Issued",
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

  async vendorDispatchOrder(
    userId: string,
    orderId: string,
  ): Promise<{ status: string; deliveryCode: string; expiresAt: Date; otpSentTo: string | null; smsSent: boolean }> {
    const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
    if (!vendor) throw new AppError("Vendor profile required", 403);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        vendorId: true,
        status: true,
        escrowType: true,
        buyerId: true,
        orderNumber: true,
        buyer: { select: { phone: true } },
      },
    });

    if (!order) throw new AppError("Order not found", 404);
    if (order.vendorId !== vendor.id) throw new AppError("Forbidden", 403);
    if (order.escrowType !== "DOMESTIC_AFRICA") throw new AppError("Not an escrow order", 400);
    if (order.status !== "VENDOR_CONFIRMED") {
      throw new AppError(`Cannot dispatch order in ${order.status} status. Must be VENDOR_CONFIRMED.`, 400);
    }

    const code = String(crypto.randomInt(100000, 999999));
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const expiresAt = new Date(Date.now() + AUTO_RELEASE_HOURS * 60 * 60 * 1000);

    await prisma.$transaction(async (tx) => {
      await tx.deliveryOtp.upsert({
        where: { orderId },
        update: {
          codeHash,
          expiresAt,
          attempts: 0,
          confirmedAt: null,
        },
        create: {
          orderId,
          codeHash,
          expiresAt,
        },
      });

      await tx.order.update({
        where: { id: orderId },
        data: {
          status: "DISPATCHED",
          escrowExpiresAt: expiresAt,
        },
      });
    });

    let smsSent = false;
    if (order.buyer?.phone) {
      smsSent = await sendSms({
        to: order.buyer.phone,
        message: `Culinary Tales delivery OTP for order ${order.orderNumber}: ${code}. This code expires in ${AUTO_RELEASE_HOURS} hours.`,
      });
    }

    await notificationsService.enqueue({
      userId: order.buyerId,
      type: "ORDER_PAID",
      title: "Your order is on the way!",
      body: `Order ${order.orderNumber} has been dispatched. Use the OTP sent to your phone to confirm delivery in the app.`,
      data: { orderId },
    });

    logger.info("Escrow: order dispatched, OTP generated", { orderId, smsSent });

    return {
      status: "DISPATCHED",
      deliveryCode: code,
      expiresAt,
      otpSentTo: maskPhone(order.buyer?.phone),
      smsSent,
    };
  },

  async resendBuyerDeliveryOtp(
    buyerId: string,
    orderId: string,
  ): Promise<{ resent: boolean; expiresAt: Date; otpSentTo: string | null; smsSent: boolean }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        buyerId: true,
        status: true,
        escrowType: true,
        orderNumber: true,
        buyer: { select: { phone: true } },
        deliveryOtp: { select: { confirmedAt: true } },
      },
    });

    if (!order) throw new AppError("Order not found", 404);
    if (order.buyerId !== buyerId) throw new AppError("Forbidden", 403);
    if (order.escrowType !== "DOMESTIC_AFRICA") throw new AppError("Not an escrow order", 400);
    if (order.status !== "DISPATCHED") throw new AppError("Delivery OTP can only be resent after dispatch", 400);
    if (!order.deliveryOtp || order.deliveryOtp.confirmedAt) {
      throw new AppError("Delivery is already confirmed or the OTP is unavailable", 409);
    }
    if (!order.buyer?.phone) {
      throw new AppError("No phone number is available for this buyer", 409);
    }

    const code = String(crypto.randomInt(100000, 999999));
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const expiresAt = new Date(Date.now() + AUTO_RELEASE_HOURS * 60 * 60 * 1000);

    await prisma.deliveryOtp.update({
      where: { orderId },
      data: {
        codeHash,
        expiresAt,
        attempts: 0,
        confirmedAt: null,
      },
    });

    const smsSent = await sendSms({
      to: order.buyer.phone,
      message: `Culinary Tales delivery OTP for order ${order.orderNumber}: ${code}. This code expires in ${AUTO_RELEASE_HOURS} hours.`,
    });

    await notificationsService.enqueue({
      userId: buyerId,
      type: "ORDER_PAID",
      title: "Delivery OTP resent",
      body: `A new delivery OTP has been sent for order ${order.orderNumber}.`,
      data: { orderId },
    });

    return {
      resent: true,
      expiresAt,
      otpSentTo: maskPhone(order.buyer.phone),
      smsSent,
    };
  },

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
    if (otp.expiresAt < new Date()) throw new AppError("Delivery code has expired", 400);
    if (otp.confirmedAt) throw new AppError("Delivery already confirmed", 409);
    if (otp.attempts >= OTP_MAX_ATTEMPTS) throw new AppError("Too many attempts. Contact support.", 429);

    await prisma.deliveryOtp.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });

    const inputHash = crypto.createHash("sha256").update(code).digest("hex");
    if (inputHash !== otp.codeHash) {
      const remaining = OTP_MAX_ATTEMPTS - otp.attempts - 1;
      throw new AppError(
        `Incorrect delivery code. ${remaining > 0 ? `${remaining} attempts remaining.` : "No attempts remaining."}`,
        400,
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.deliveryOtp.update({
        where: { id: otp.id },
        data: { confirmedAt: new Date() },
      });

      await tx.order.update({
        where: { id: orderId },
        data: { status: "COMPLETED", deliveredAt: new Date() },
      });

      await tx.user.update({
        where: { id: buyerId },
        data: { trustScore: { increment: 2 } },
      });
    });

    if (order.vendorId) {
      const vendor = await prisma.vendor.findUnique({ where: { id: order.vendorId }, select: { userId: true } });
      if (vendor) {
        await notificationsService.enqueue({
          userId: vendor.userId,
          type: "BALANCE_CREDITED",
          title: "Delivery Confirmed",
          body: `Order ${order.orderNumber} delivery confirmed. Payment will be released to your account.`,
          data: { orderId },
        });
      }
    }

    logger.info("Escrow: delivery confirmed via OTP", { orderId, buyerId });

    this.initiateVendorPayout(orderId).catch((err) => {
      logger.error("Post-OTP payout initiation failed", { orderId, error: String(err) });
    });

    // Release wallet earnings so vendor can request payout
    releaseVendorEarnings(orderId).catch((err) => {
      logger.error("Post-OTP wallet release failed", { orderId, error: String(err) });
    });

    return { confirmed: true };
  },

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
          await tx.order.update({
            where: { id: order.id },
            data: { status: "COMPLETED", autoReleasedAt: now, deliveredAt: now },
          });

          await tx.user.update({
            where: { id: order.buyerId },
            data: { trustScore: { decrement: 1 } },
          });
        });

        if (order.vendorId) {
          const vendor = await prisma.vendor.findUnique({ where: { id: order.vendorId }, select: { userId: true } });
          if (vendor) {
            await notificationsService.enqueue({
              userId: vendor.userId,
              type: "BALANCE_CREDITED",
              title: "Payment Auto-Released",
              body: `Order ${order.orderNumber} - payment of ${order.vendorEarnings / 100} ${order.currency} has been released after the protection window expired.`,
              data: { orderId: order.id },
            });
          }
        }

        processed++;
        logger.info("Escrow auto-release: completed", { orderId: order.id });

        this.initiateVendorPayout(order.id).catch((err) => {
          logger.error("Auto-release payout initiation failed", { orderId: order.id, error: String(err) });
        });

        releaseVendorEarnings(order.id).catch((err) => {
          logger.error("Auto-release wallet release failed", { orderId: order.id, error: String(err) });
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
    const resolved = await paystack.resolveAccountNumber(input.accountNumber, input.bankCode);
    const recipient = await paystack.createTransferRecipient({
      name: resolved.account_name,
      accountNumber: input.accountNumber,
      bankCode: input.bankCode,
      currency,
    });

    await prisma.vendorBankAccount.updateMany({
      where: { vendorId: vendor.id, isDefault: true },
      data: { isDefault: false },
    });

    const account = await prisma.vendorBankAccount.create({
      data: {
        vendorId: vendor.id,
        bankName: resolved.account_name,
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
      bankName: input.bankCode,
      accountName: resolved.account_name,
      accountNumber: input.accountNumber,
    };
  },

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

    return prisma.vendorBankAccount.findMany({
      where: { vendorId: vendor.id },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
      select: { id: true, bankCode: true, accountNumber: true, accountName: true, currency: true, isDefault: true },
    });
  },

  async initiateVendorPayout(orderId: string): Promise<void> {
    if (!paystack.isConfigured()) {
      logger.warn("Paystack payout skipped - not configured", { orderId });
      return;
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, vendorId: true, vendorEarnings: true, currency: true, orderNumber: true },
    });

    if (!order || !order.vendorId) return;

    const bankAccount = await prisma.vendorBankAccount.findFirst({
      where: { vendorId: order.vendorId, isDefault: true },
      select: { paystackRecipientCode: true },
    });

    if (!bankAccount?.paystackRecipientCode) {
      logger.warn("Vendor payout skipped - no bank account with recipient code", { orderId, vendorId: order.vendorId });
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
    }
  },
};
