import {
  NotificationType,
  PayoutRequestStatus,
  Prisma,
  WalletTransactionType,
  type PayoutRequest,
} from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { notificationsService } from "../notifications/notifications.service";
import { AppError } from "../../shared/errors/app-error";
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

      return tx.payoutRequest.create({
        data: {
          vendorId: vendor.id,
          payoutMethodId: payoutMethod.id,
          amount: input.amount,
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
      body: `Your payout of ${created.amount} ${created.currency} is pending review.`,
      data: { payoutRequestId: created.id, amount: created.amount, currency: created.currency },
    });

    return created;
  },

  async listOwn(userId: string): Promise<PayoutRequest[]> {
    const vendor = await getVendorForUser(userId);
    return prisma.payoutRequest.findMany({
      where: { vendorId: vendor.id },
      orderBy: { createdAt: "desc" },
    });
  },

  async adminList(query: ListPayoutRequestsQuery): Promise<PayoutRequest[]> {
    return prisma.payoutRequest.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: { createdAt: "desc" },
    });
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
        body: `Your payout of ${payout.amount} ${payout.currency} has been approved.`,
        data: { payoutRequestId: payout.id },
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
        data: { payoutRequestId: payout.id },
      });
    }

    return payout;
  },

  /**
   * Mark payout as paid with atomic balance deduction.
   * Uses conditional updateMany on wallet to prevent negative balance.
   * Idempotent: if already PAID, returns 409.
   */
  async adminMarkPaid(adminId: string, payoutRequestId: string): Promise<PayoutRequest> {
    try {
      const payout = await prisma.$transaction(async (tx) => {
        // Conditional status transition: APPROVED → PAID
        const transitionResult = await tx.payoutRequest.updateMany({
          where: { id: payoutRequestId, status: PayoutRequestStatus.APPROVED },
          data: { status: PayoutRequestStatus.PAID, paidById: adminId, paidAt: new Date() },
        });

        if (transitionResult.count === 0) {
          const current = await tx.payoutRequest.findUnique({ where: { id: payoutRequestId } });
          if (!current) throw new AppError("Payout request not found", 404);
          if (current.status === PayoutRequestStatus.PAID) throw new AppError("Payout already marked paid", 409);
          throw new AppError("Payout must be approved before being marked paid", 400);
        }

        const payoutRecord = await tx.payoutRequest.findUniqueOrThrow({ where: { id: payoutRequestId } });

        // Atomic conditional balance deduction (prevents negative balance)
        const walletUpdate = await tx.wallet.updateMany({
          where: {
            vendorId: payoutRecord.vendorId,
            availableBalance: { gte: payoutRecord.amount },
          },
          data: { availableBalance: { decrement: payoutRecord.amount } },
        });

        if (walletUpdate.count === 0) {
          throw new AppError("Insufficient available balance", 400);
        }

        // Get wallet ID for ledger entry
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { vendorId: payoutRecord.vendorId } });

        // Create ledger entry
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

      const vendorUserId = await getVendorUserId(payout.vendorId);
      if (vendorUserId) {
        await notificationsService.enqueue({
          userId: vendorUserId,
          type: NotificationType.PAYOUT_PAID,
          title: "Payout paid",
          body: `Your payout of ${payout.amount} ${payout.currency} has been paid.`,
          data: { payoutRequestId: payout.id },
        });
      }

      return payout;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError("Payout already processed", 409);
      }
      throw error;
    }
  },
};
