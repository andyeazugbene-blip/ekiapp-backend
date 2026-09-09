import {
  NotificationType,
  PayoutRequestStatus,
  Prisma,
  WalletTransactionType,
  type PayoutRequest,
} from "@prisma/client";

import { stripe } from "../../lib/stripe";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { calculateWithdrawalFee } from "../../shared/pricing";
import { notificationsService } from "../notifications/notifications.service";
import { resolveVendorWithdrawalFeeBps } from "../subscriptions/subscription-plan-utils";
import { AppError } from "../../shared/errors/app-error";
import { emailTemplates } from "../../lib/email-templates";
import { enqueueEmail } from "../../lib/email-queue";
import type {
  CreatePayoutRequestInput,
  ListPayoutRequestsQuery,
  RejectPayoutRequestInput,
} from "./payouts.types";

async function getVendorForUser(userId: string): Promise<{ id: string }> {
  const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
  if (!vendor) throw new AppError("Vendor profile required", 403);
  return vendor;
}

async function getVendorUserId(vendorId: string): Promise<string | null> {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true } });
  return vendor?.userId ?? null;
}

/** Fires only once a payout is genuinely PAID — shared by the Stripe and manual paths so both notify identically. */
async function sendPayoutPaidNotificationAndReceipt(payout: PayoutRequest): Promise<void> {
  const vendorUserId = await getVendorUserId(payout.vendorId);
  if (vendorUserId) {
    await notificationsService.enqueue({
      userId: vendorUserId,
      type: NotificationType.PAYOUT_PAID,
      title: "Payout paid",
      body: `Your payout of ${payout.netAmount ?? payout.amount} ${payout.currency} has been paid.`,
      // NAV-04 fix: data.type is what the frontend's notification tap-router
      // matches on — this payload previously had no type at all, so tapping
      // did nothing regardless of what the frontend supported.
      data: { type: "payout_paid", payoutRequestId: payout.id },
    });
  }

  try {
    const vendorRecord = await prisma.vendor.findUnique({
      where: { id: payout.vendorId },
      select: { storeName: true, user: { select: { email: true, name: true } } },
    });
    if (vendorRecord?.user?.email) {
      const netAmount = payout.netAmount ?? payout.amount;
      const feeAmount = payout.withdrawalFeeAmount ?? (payout.amount - netAmount);
      const template = {
        subject: `Payout completed — ${(netAmount / 100).toFixed(2)} ${payout.currency}`,
        html: `<p>Hi ${vendorRecord.user.name ?? vendorRecord.storeName},</p>
<p>Your payout of <strong>${(netAmount / 100).toFixed(2)} ${payout.currency}</strong> has been completed.</p>
<p><strong>Details:</strong><br/>
Gross amount: ${(payout.amount / 100).toFixed(2)} ${payout.currency}<br/>
Fee: ${(feeAmount / 100).toFixed(2)} ${payout.currency}<br/>
Net amount: ${(netAmount / 100).toFixed(2)} ${payout.currency}</p>
<p>You can view your payout history in your Eki vendor dashboard.</p>`,
      };
      await enqueueEmail({ to: vendorRecord.user.email, subject: template.subject, html: template.html });
    }
  } catch (emailError) {
    logger.error("Failed to send payout completed email", {
      payoutId: payout.id,
      errorMessage: emailError instanceof Error ? emailError.message : String(emailError),
    });
  }
}

export const payoutsService = {
  /**
   * Create payout request with atomic balance check.
   * Uses a transaction to prevent concurrent requests from overdrawing.
   */
  async createRequest(userId: string, input: CreatePayoutRequestInput): Promise<PayoutRequest> {
    const vendor = await getVendorForUser(userId);

    const payoutMethod = await prisma.payoutMethod.findUnique({ where: { id: input.payoutMethodId } });
    if (!payoutMethod || payoutMethod.vendorId !== vendor.id) {
      throw new AppError("Payout method not found", 404);
    }

    // Atomic: check balance and create request in one transaction
    const created = await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { vendorId: vendor.id } });
      if (!wallet) throw new AppError("Vendor wallet not found", 404);
      if (input.amount > wallet.availableBalance) {
        throw new AppError("Insufficient available balance", 400);
      }
      const withdrawalFeeBps = await resolveVendorWithdrawalFeeBps(vendor.id, tx);
      const withdrawalFeeAmount = calculateWithdrawalFee(input.amount, withdrawalFeeBps);
      const netAmount = Math.max(0, input.amount - withdrawalFeeAmount);

      return tx.payoutRequest.create({
        data: {
          vendorId: vendor.id,
          payoutMethodId: payoutMethod.id,
          amount: input.amount,
          withdrawalFeeAmount,
          withdrawalFeeBps,
          netAmount,
          currency: wallet.currency,
          status: PayoutRequestStatus.PENDING,
          notes: input.notes,
        },
      });
    });

    await notificationsService.enqueue({
      userId,
      type: NotificationType.PAYOUT_REQUESTED,
      title: "Payout requested",
      body: `Your payout of ${created.netAmount ?? created.amount} ${created.currency} is pending review after withdrawal fees.`,
      // NAV-04 fix — see PAYOUT_PAID above for context.
      data: { type: "payout_requested", payoutRequestId: created.id, amount: created.amount, netAmount: created.netAmount, currency: created.currency },
    });

    return created;
  },

  async listOwn(userId: string): Promise<PayoutRequest[]> {
    const vendor = await getVendorForUser(userId);
    return prisma.payoutRequest.findMany({
      where: { vendorId: vendor.id },
      orderBy: CURSOR_ORDER_BY,
    });
  },

  async adminList(query: ListPayoutRequestsQuery): Promise<any[]> {
    const items = await prisma.payoutRequest.findMany({
      where: query.status ? { status: query.status } : {},
      include: { vendor: { select: { id: true, storeName: true, userId: true } }, payoutMethod: { select: { id: true, type: true, label: true } } },
      orderBy: CURSOR_ORDER_BY,
    });
    return items;
  },

  async adminGet(id: string): Promise<any> {
    const item = await prisma.payoutRequest.findUnique({
      where: { id },
      include: {
        vendor: { select: { id: true, storeName: true, userId: true, contactEmail: true, country: true, stripeAccountId: true } },
        payoutMethod: true,
        walletTransactions: true,
      },
    });
    if (!item) throw new AppError("Payout request not found", 404);
    return item;
  },

  /**
   * Approve: conditional update (only if PENDING).
   */
  async adminApprove(adminId: string, payoutRequestId: string): Promise<PayoutRequest> {
    const result = await prisma.payoutRequest.updateMany({
      where: { id: payoutRequestId, status: PayoutRequestStatus.PENDING },
      data: { status: PayoutRequestStatus.APPROVED, approvedById: adminId, approvedAt: new Date() },
    });

    if (result.count === 0) {
      const current = await prisma.payoutRequest.findUnique({ where: { id: payoutRequestId } });
      if (!current) throw new AppError("Payout request not found", 404);
      if (current.status === PayoutRequestStatus.APPROVED) throw new AppError("Already approved", 409);
      throw new AppError(`Cannot approve payout in status ${current.status}`, 409);
    }

    const payout = await prisma.payoutRequest.findUniqueOrThrow({ where: { id: payoutRequestId } });

    const vendorUserId = await getVendorUserId(payout.vendorId);
    if (vendorUserId) {
      await notificationsService.enqueue({
        userId: vendorUserId,
        type: NotificationType.PAYOUT_APPROVED,
        title: "Payout approved",
        body: `Your payout of ${payout.netAmount ?? payout.amount} ${payout.currency} has been approved.`,
        // NAV-04 fix — see PAYOUT_PAID above for context.
        data: { type: "payout_approved", payoutRequestId: payout.id },
      });
    }

    // ─── Send email receipt to vendor ─────────────────────────────────────
    try {
      const vendorRecord = await prisma.vendor.findUnique({
        where: { id: payout.vendorId },
        select: {
          storeName: true,
          user: { select: { email: true, name: true } },
        },
      });

      if (vendorRecord?.user?.email) {
        const netAmount = payout.netAmount ?? payout.amount;
        const feeAmount = payout.withdrawalFeeAmount ?? (payout.amount - netAmount);
        const template = emailTemplates.payoutApproved({
          name: vendorRecord.user.name ?? vendorRecord.storeName,
          storeName: vendorRecord.storeName,
          amount: payout.amount,
          netAmount,
          feeAmount,
          currency: payout.currency,
          payoutId: payout.id,
        });
        await enqueueEmail({
          to: vendorRecord.user.email,
          subject: template.subject,
          html: template.html,
        });
      }
    } catch (emailError) {
      // Email failure must not break the payout approval flow
      logger.error("Failed to send payout receipt email", {
        payoutId: payout.id,
        vendorId: payout.vendorId,
        errorMessage: emailError instanceof Error ? emailError.message : String(emailError),
      });
    }

    return payout;
  },

  async adminReject(adminId: string, payoutRequestId: string, input: RejectPayoutRequestInput): Promise<PayoutRequest> {
    const result = await prisma.payoutRequest.updateMany({
      where: { id: payoutRequestId, status: PayoutRequestStatus.PENDING },
      data: { status: PayoutRequestStatus.REJECTED, approvedById: adminId, approvedAt: new Date(), rejectionReason: input.reason ?? null },
    });

    if (result.count === 0) {
      const current = await prisma.payoutRequest.findUnique({ where: { id: payoutRequestId } });
      if (!current) throw new AppError("Payout request not found", 404);
      throw new AppError(`Cannot reject payout in status ${current.status}`, 409);
    }

    const payout = await prisma.payoutRequest.findUniqueOrThrow({ where: { id: payoutRequestId } });

    const vendorUserId = await getVendorUserId(payout.vendorId);
    if (vendorUserId) {
      await notificationsService.enqueue({
        userId: vendorUserId,
        type: NotificationType.PAYOUT_REJECTED,
        title: "Payout rejected",
        body: payout.rejectionReason ? `Your payout was rejected: ${payout.rejectionReason}` : "Your payout has been rejected.",
        // NAV-04 fix — see PAYOUT_PAID above for context.
        data: { type: "payout_rejected", payoutRequestId: payout.id },
      });
    }

    return payout;
  },

  /**
   * Mark payout as paid.
   *
   * P0 fix (2026-09): status must never read PAID before the real transfer
   * has actually succeeded. Previously the DB transition to PAID, the wallet
   * balance decrement, and the ledger entry all committed BEFORE the Stripe
   * Connect transfer was even attempted — a thrown/failed transfer left the
   * request permanently recorded as "paid" (and told the vendor so) with no
   * real money movement and no recovery path.
   *
   * Only the Stripe-auto-transfer path is money-provider-ambiguous, so only
   * that path changes shape. Manual payout methods (bank/PayPal, where the
   * admin performs the transfer themselves outside Stripe and supplies
   * transferProof as evidence) keep their original, correct behavior — the
   * admin's own confirmation IS the provider confirmation for those; there is
   * no external API call on that path to fail ambiguously.
   *
   * For Stripe: APPROVED (first attempt) or ON_HOLD/PROCESSING (retry after
   * a prior failure or an interrupted attempt) → PROCESSING → real Stripe
   * transfer, with a deterministic idempotency key so a retry can never
   * create a duplicate transfer → PAID only once Stripe confirms, storing
   * the real transferId. Any thrown error (decline, timeout, network) moves
   * to ON_HOLD with the reason preserved — never assumed failed, never
   * assumed paid; safe to retry by calling this again, which replays the
   * same idempotency key.
   *
   * The wallet debit + ledger entry are posted exactly once, at the first
   * APPROVED → PROCESSING transition (atomic, balance-gated) — a retry from
   * ON_HOLD/PROCESSING must never re-debit.
   */
  async adminMarkPaid(adminId: string, payoutRequestId: string, transferProof?: string): Promise<PayoutRequest> {
    const existing = await prisma.payoutRequest.findUnique({ where: { id: payoutRequestId } });
    if (!existing) throw new AppError("Payout request not found", 404);
    if (existing.status === PayoutRequestStatus.PAID) return existing; // idempotent no-op — matches releaseSupplierPayment's pattern.

    const method = await prisma.payoutMethod.findUnique({ where: { id: existing.payoutMethodId } });
    const methodDetails = (method?.details ?? {}) as Record<string, unknown>;
    const isStripe = (method?.type ?? "OTHER") === "OTHER" && methodDetails.provider === "stripe";
    const isPaypal = (method?.type ?? "OTHER") === "OTHER" && methodDetails.provider === "paypal";

    if (!isStripe) {
      // ─── Manual payout methods — unchanged behavior ──────────────────────
      // No provider call of ours can fail ambiguously here; the admin's own
      // transferProof is the confirmation. Only APPROVED can start this path.
      try {
        const payout = await prisma.$transaction(async (tx) => {
          const notesParts: string[] = [];
          if (transferProof) notesParts.push(`Transfer proof: ${transferProof}`);
          const transitionResult = await tx.payoutRequest.updateMany({
            where: { id: payoutRequestId, status: PayoutRequestStatus.APPROVED },
            data: {
              status: PayoutRequestStatus.PAID,
              paidById: adminId,
              paidAt: new Date(),
              notes: notesParts.length > 0 ? notesParts.join("; ") : undefined,
            },
          });
          if (transitionResult.count === 0) {
            const current = await tx.payoutRequest.findUniqueOrThrow({ where: { id: payoutRequestId } });
            if (current.status === PayoutRequestStatus.PAID) throw new AppError("Payout already marked paid", 409);
            throw new AppError(`Payout must be approved before being marked paid (currently ${current.status})`, 400);
          }
          const payoutRecord = await tx.payoutRequest.findUniqueOrThrow({ where: { id: payoutRequestId } });
          const walletUpdate = await tx.wallet.updateMany({
            where: { vendorId: payoutRecord.vendorId, availableBalance: { gte: payoutRecord.amount } },
            data: { availableBalance: { decrement: payoutRecord.amount } },
          });
          if (walletUpdate.count === 0) throw new AppError("Insufficient available balance", 400);
          const wallet = await tx.wallet.findUniqueOrThrow({ where: { vendorId: payoutRecord.vendorId } });
          await tx.walletTransaction.create({
            data: {
              walletId: wallet.id,
              vendorId: payoutRecord.vendorId,
              payoutRequestId: payoutRecord.id,
              type: WalletTransactionType.PAYOUT_DEBIT,
              amount: payoutRecord.amount,
              currency: payoutRecord.currency,
              description: `Payout paid: ${payoutRecord.id}`,
            },
          });
          return payoutRecord;
        });
        if (isPaypal) logger.info("PayPal payout marked paid — manual processing performed by admin", { payoutId: payout.id, vendorId: payout.vendorId });
        await sendPayoutPaidNotificationAndReceipt(payout);
        return payout;
      } catch (error) {
        if ((error as any)?.code === "P2002") throw new AppError("Payout already processed", 409);
        throw error;
      }
    }

    // ─── Stripe Connect auto-transfer path ─────────────────────────────────
    const startableStatuses: PayoutRequestStatus[] = [PayoutRequestStatus.APPROVED, PayoutRequestStatus.ON_HOLD, PayoutRequestStatus.PROCESSING];
    if (!startableStatuses.includes(existing.status)) {
      throw new AppError(`Payout must be approved (or on hold/processing) before being marked paid — currently ${existing.status}`, 400);
    }
    const isFirstAttempt = existing.status === PayoutRequestStatus.APPROVED;

    let processing: PayoutRequest;
    try {
      processing = await prisma.$transaction(async (tx) => {
        const transitionResult = await tx.payoutRequest.updateMany({
          where: { id: payoutRequestId, status: existing.status },
          data: { status: PayoutRequestStatus.PROCESSING, paidById: adminId },
        });
        if (transitionResult.count === 0) {
          const current = await tx.payoutRequest.findUniqueOrThrow({ where: { id: payoutRequestId } });
          throw new AppError(`Payout is no longer in a startable state (now ${current.status})`, 409);
        }
        const payoutRecord = await tx.payoutRequest.findUniqueOrThrow({ where: { id: payoutRequestId } });

        if (isFirstAttempt) {
          // Hard balance gate — only ever applied once, on the real first attempt.
          const walletUpdate = await tx.wallet.updateMany({
            where: { vendorId: payoutRecord.vendorId, availableBalance: { gte: payoutRecord.amount } },
            data: { availableBalance: { decrement: payoutRecord.amount } },
          });
          if (walletUpdate.count === 0) throw new AppError("Insufficient available balance", 400);
          const wallet = await tx.wallet.findUniqueOrThrow({ where: { vendorId: payoutRecord.vendorId } });
          await tx.walletTransaction.create({
            data: {
              walletId: wallet.id,
              vendorId: payoutRecord.vendorId,
              payoutRequestId: payoutRecord.id,
              type: WalletTransactionType.PAYOUT_DEBIT,
              amount: payoutRecord.amount,
              currency: payoutRecord.currency,
              description: `Payout paid: ${payoutRecord.id}`,
            },
          });
        }
        return payoutRecord;
      });
    } catch (error) {
      if ((error as any)?.code === "P2002") throw new AppError("Payout already processed", 409);
      throw error;
    }

    const vendor = await prisma.vendor.findUnique({
      where: { id: processing.vendorId },
      select: { stripeAccountId: true, stripePayoutsEnabled: true },
    });
    if (!vendor?.stripeAccountId || !vendor?.stripePayoutsEnabled) {
      const held = await prisma.payoutRequest.update({
        where: { id: payoutRequestId },
        data: { status: PayoutRequestStatus.ON_HOLD, holdReason: "Vendor's Stripe Connect account is not connected or not enabled for payouts." },
      });
      logger.warn("Stripe Connect: vendor not eligible for auto-transfer — held for manual review", { payoutId: processing.id, vendorId: processing.vendorId });
      return held;
    }

    let transferId: string;
    try {
      const netAmount = processing.netAmount ?? processing.amount;
      const transfer = await stripe.transfers.create(
        {
          amount: netAmount,
          currency: processing.currency.toLowerCase(),
          destination: vendor.stripeAccountId,
          description: `Payout ${processing.id}`,
        },
        // Deterministic per payout request — a retry after a timeout/crash
        // (including one where the DB write below never happened) safely
        // replays this exact key: Stripe returns the original transfer
        // instead of creating a second, real duplicate.
        { idempotencyKey: `payout-transfer:${processing.id}` },
      );
      transferId = transfer.id;
    } catch (stripeError) {
      // Timeout, decline, or any other error — never assume success, never
      // assume the transfer definitely didn't happen either. ON_HOLD is
      // safe to retry: retrying replays the same idempotency key above.
      const message = stripeError instanceof Error ? stripeError.message : String(stripeError);
      const held = await prisma.payoutRequest.update({
        where: { id: payoutRequestId },
        data: { status: PayoutRequestStatus.ON_HOLD, holdReason: `Transfer failed or could not be confirmed: ${message}` },
      });
      logger.error("Stripe Connect auto-transfer failed — held for retry", { payoutId: processing.id, vendorId: processing.vendorId, error: message });
      return held;
    }

    const paid = await prisma.payoutRequest.update({
      where: { id: payoutRequestId },
      data: { status: PayoutRequestStatus.PAID, paidAt: new Date(), stripeTransferId: transferId, holdReason: null },
    });
    logger.info("Stripe Connect auto-transfer completed", { payoutId: paid.id, vendorId: paid.vendorId, stripeTransferId: transferId });

    await sendPayoutPaidNotificationAndReceipt(paid);
    return paid;
  },

  /**
   * Vendor: get payout request history with pagination.
   */
  async listOwnWithDetails(userId: string): Promise<any[]> {
    const vendor = await getVendorForUser(userId);
    const items = await prisma.payoutRequest.findMany({
      where: { vendorId: vendor.id },
      include: {
        payoutMethod: { select: { id: true, type: true, label: true } },
        walletTransactions: {
          select: { id: true, type: true, amount: true, createdAt: true },
        },
      },
      orderBy: CURSOR_ORDER_BY,
    });
    return items;
  },
};
