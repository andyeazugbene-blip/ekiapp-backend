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
  const vendor = await prisma.vendor.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!vendor) {
    throw new AppError("Vendor profile required", 403);
  }
  return vendor;
}

async function getVendorUserId(vendorId: string): Promise<string | null> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { userId: true },
  });
  return vendor?.userId ?? null;
}

export const payoutsService = {
  async createRequest(userId: string, input: CreatePayoutRequestInput): Promise<PayoutRequest> {
    const vendor = await getVendorForUser(userId);

    const [payoutMethod, wallet] = await Promise.all([
      prisma.payoutMethod.findUnique({ where: { id: input.payoutMethodId } }),
      prisma.wallet.findUnique({ where: { vendorId: vendor.id } }),
    ]);

    if (!payoutMethod || payoutMethod.vendorId !== vendor.id) {
      throw new AppError("Payout method not found", 404);
    }
    if (!wallet) {
      throw new AppError("Vendor wallet not found", 404);
    }
    if (input.amount > wallet.availableBalance) {
      throw new AppError("Insufficient available balance", 400);
    }

    const created = await prisma.payoutRequest.create({
      data: {
        vendorId: vendor.id,
        payoutMethodId: payoutMethod.id,
        amount: input.amount,
        currency: wallet.currency,
        status: PayoutRequestStatus.PENDING,
        notes: input.notes,
      },
    });

    await notificationsService.create({
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

  async adminApprove(adminId: string, payoutRequestId: string): Promise<PayoutRequest> {
    const result = await prisma.payoutRequest.updateMany({
      where: { id: payoutRequestId, status: PayoutRequestStatus.PENDING },
      data: {
        status: PayoutRequestStatus.APPROVED,
        approvedById: adminId,
        approvedAt: new Date(),
      },
    });

    if (result.count === 0) {
      await this.assertTransitionable(payoutRequestId, [PayoutRequestStatus.PENDING]);
    }

    const payout = await prisma.payoutRequest.findUniqueOrThrow({
      where: { id: payoutRequestId },
    });

    const vendorUserId = await getVendorUserId(payout.vendorId);
    if (vendorUserId) {
      await notificationsService.create({
        userId: vendorUserId,
        type: NotificationType.PAYOUT_APPROVED,
        title: "Payout approved",
        body: `Your payout of ${payout.amount} ${payout.currency} has been approved.`,
        data: { payoutRequestId: payout.id },
      });
    }

    return payout;
  },

  async adminReject(
    adminId: string,
    payoutRequestId: string,
    input: RejectPayoutRequestInput,
  ): Promise<PayoutRequest> {
    const result = await prisma.payoutRequest.updateMany({
      where: { id: payoutRequestId, status: PayoutRequestStatus.PENDING },
      data: {
        status: PayoutRequestStatus.REJECTED,
        approvedById: adminId,
        approvedAt: new Date(),
        rejectionReason: input.reason ?? null,
      },
    });

    if (result.count === 0) {
      await this.assertTransitionable(payoutRequestId, [PayoutRequestStatus.PENDING]);
    }

    const payout = await prisma.payoutRequest.findUniqueOrThrow({
      where: { id: payoutRequestId },
    });

    const vendorUserId = await getVendorUserId(payout.vendorId);
    if (vendorUserId) {
      await notificationsService.create({
        userId: vendorUserId,
        type: NotificationType.PAYOUT_REJECTED,
        title: "Payout rejected",
        body: payout.rejectionReason
          ? `Your payout was rejected: ${payout.rejectionReason}`
          : "Your payout has been rejected.",
        data: { payoutRequestId: payout.id },
      });
    }

    return payout;
  },

  async adminMarkPaid(adminId: string, payoutRequestId: string): Promise<PayoutRequest> {
    try {
      const payout = await prisma.$transaction(async (tx) => {
        const payout = await tx.payoutRequest.findUnique({
          where: { id: payoutRequestId },
        });
        if (!payout) {
          throw new AppError("Payout request not found", 404);
        }
        if (payout.status === PayoutRequestStatus.PAID) {
          throw new AppError("Payout already marked paid", 409);
        }
        if (payout.status !== PayoutRequestStatus.APPROVED) {
          throw new AppError("Payout must be approved before being marked paid", 400);
        }

        const wallet = await tx.wallet.findUnique({
          where: { vendorId: payout.vendorId },
        });
        if (!wallet) {
          throw new AppError("Vendor wallet not found", 404);
        }
        if (payout.amount > wallet.availableBalance) {
          throw new AppError("Insufficient available balance", 400);
        }

        const marked = await tx.payoutRequest.updateMany({
          where: { id: payout.id, status: PayoutRequestStatus.APPROVED },
          data: {
            status: PayoutRequestStatus.PAID,
            paidById: adminId,
            paidAt: new Date(),
          },
        });
        if (marked.count === 0) {
          throw new AppError("Payout state changed concurrently", 409);
        }

        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            vendorId: payout.vendorId,
            payoutRequestId: payout.id,
            type: WalletTransactionType.PAYOUT_DEBIT,
            amount: payout.amount,
            currency: payout.currency,
            description: `Payout paid for request ${payout.id}`,
          },
        });

        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            availableBalance: { decrement: payout.amount },
          },
        });

        return tx.payoutRequest.findUniqueOrThrow({ where: { id: payout.id } });
      });

      const vendorUserId = await getVendorUserId(payout.vendorId);
      if (vendorUserId) {
        await notificationsService.create({
          userId: vendorUserId,
          type: NotificationType.PAYOUT_PAID,
          title: "Payout paid",
          body: `Your payout of ${payout.amount} ${payout.currency} has been paid.`,
          data: { payoutRequestId: payout.id },
        });
      }

      return payout;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new AppError("Payout already processed", 409);
      }
      throw error;
    }
  },

  async assertTransitionable(
    payoutRequestId: string,
    allowedFrom: PayoutRequestStatus[],
  ): Promise<never> {
    const current = await prisma.payoutRequest.findUnique({
      where: { id: payoutRequestId },
      select: { status: true },
    });
    if (!current) {
      throw new AppError("Payout request not found", 404);
    }
    if (!allowedFrom.includes(current.status)) {
      throw new AppError(
        `Cannot transition payout in status ${current.status}`,
        409,
      );
    }
    throw new AppError("Payout state changed concurrently", 409);
  },
};
