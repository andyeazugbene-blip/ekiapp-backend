import { NotificationType } from "@prisma/client";
import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { enqueueEmail } from "../../lib/email-queue";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { notificationsService } from "../notifications/notifications.service";
import { requireReason } from "./admin-suspension.service";

/**
 * Handbook 14.7 L576: "Replace Delete Vendor with controlled Close/Anonymise
 * Account after financial and dispute checks."
 *
 * Closing NEVER hard-deletes. Orders, payments, payouts, disputes and the
 * audit trail are kept; the store is switched off, products unpublished,
 * personal data scrubbed and the owner signed out.
 */

const OPEN_ORDER_STATUSES = [
  "PAID", "CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT",
  "PAYMENT_SECURED", "VENDOR_CONFIRMED", "DISPUTED",
] as const;
const OPEN_PAYOUT_STATUSES = ["PENDING", "APPROVED", "PROCESSING", "ON_HOLD"] as const;

export interface CloseBlocker {
  code: "OPEN_ORDERS" | "OPEN_DISPUTES" | "WALLET_BALANCE" | "PENDING_PAYOUTS" | "ALREADY_CLOSED";
  message: string;
  count?: number;
  amount?: number;
  currency?: string;
}

export async function findVendorCloseBlockers(vendorId: string): Promise<CloseBlocker[]> {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true, closedAt: true, currency: true } });
  if (!vendor) throw new AppError("Vendor not found", 404);
  if (vendor.closedAt) {
    return [{ code: "ALREADY_CLOSED", message: "This vendor account is already closed." }];
  }

  const [openOrders, openDisputes, wallet, pendingPayouts] = await Promise.all([
    prisma.order.count({ where: { vendorId, status: { in: [...OPEN_ORDER_STATUSES] as never } } }),
    prisma.dispute.count({ where: { vendorId, status: "OPEN" as never } }),
    prisma.wallet.findUnique({ where: { vendorId }, select: { pendingBalance: true, availableBalance: true, currency: true } }),
    prisma.payoutRequest.count({ where: { vendorId, status: { in: [...OPEN_PAYOUT_STATUSES] as never } } }),
  ]);

  const blockers: CloseBlocker[] = [];
  if (openOrders > 0) blockers.push({ code: "OPEN_ORDERS", count: openOrders, message: `${openOrders} order(s) are still in progress. Complete or cancel them first.` });
  if (openDisputes > 0) blockers.push({ code: "OPEN_DISPUTES", count: openDisputes, message: `${openDisputes} dispute(s) are open. Resolve them first.` });
  const balance = (wallet?.pendingBalance ?? 0) + (wallet?.availableBalance ?? 0);
  if (balance > 0) blockers.push({ code: "WALLET_BALANCE", amount: balance, currency: wallet?.currency ?? vendor.currency, message: "The vendor still has an unpaid wallet balance. Pay it out (or resolve it) first." });
  if (pendingPayouts > 0) blockers.push({ code: "PENDING_PAYOUTS", count: pendingPayouts, message: `${pendingPayouts} payout request(s) are not settled yet.` });
  return blockers;
}

/** GET /admin/vendors/:id/close-check - lets the UI show blockers before asking for a reason. */
export async function checkVendorClose(request: Request, response: Response): Promise<void> {
  const blockers = await findVendorCloseBlockers(String(request.params.id));
  response.status(200).json({ canClose: blockers.length === 0, blockers });
}

/** POST /admin/vendors/:id/close  { reason } */
export async function closeVendor(request: Request, response: Response): Promise<void> {
  const adminId = request.user?.id;
  if (!adminId) throw new AppError("Unauthorized", 401);
  const vendorId = String(request.params.id);
  const reason = requireReason(request.body?.reason);

  const blockers = await findVendorCloseBlockers(vendorId);
  if (blockers.length > 0) {
    throw new AppError("This vendor cannot be closed yet.", 409, { blockers }, "VENDOR_CLOSE_BLOCKED");
  }

  const vendor = await prisma.vendor.findUniqueOrThrow({
    where: { id: vendorId },
    include: { user: { select: { id: true, email: true, role: true } } },
  });
  if (vendor.user.role === "ADMIN") throw new AppError("Admin accounts cannot be closed here", 409);

  // Tell the owner BEFORE the contact details are scrubbed.
  const ownerEmail = vendor.user.email;
  await notificationsService.enqueue({
    userId: vendor.userId,
    type: NotificationType.ADMIN_BROADCAST,
    title: "Your Eki store has been closed",
    body: `Reason: ${reason}. Your order and payout history is kept for our records. Contact Eki support if you think this is a mistake.`,
    data: { type: "vendor_closed", vendorId },
  }).catch(() => undefined);
  if (ownerEmail && !/@anonymized\.local$/i.test(ownerEmail)) {
    await enqueueEmail({
      to: ownerEmail,
      subject: "Your Eki store has been closed",
      html: `<p>Your store <strong>${vendor.storeName.replace(/[<>&]/g, "")}</strong> has been closed.</p><p>Reason: ${reason.replace(/[<>&]/g, "")}</p><p>Your order and payout history is kept for our records. Reply to this email or contact Eki support if you believe this is a mistake.</p>`,
    }).catch(() => undefined);
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.pushToken.deleteMany({ where: { userId: vendor.userId } });
    await tx.product.updateMany({ where: { vendorId }, data: { isActive: false } });
    await tx.vendor.update({
      where: { id: vendorId },
      data: {
        isSuspended: true,
        closedAt: now,
        suspendedAt: vendor.suspendedAt ?? now,
        suspendedById: adminId,
        suspendedReason: `Closed: ${reason}`,
        contactEmail: null,
        contactPhone: null,
        description: null,
      },
    });
    await tx.user.update({
      where: { id: vendor.userId },
      data: {
        email: `deleted_${vendor.userId}@anonymized.local`,
        name: "Deleted user",
        phone: null,
        avatar: null,
        country: null,
        password: `deleted:${vendor.userId}`,
        anonymisedAt: now,
        isSuspended: true,
        suspendedReason: `Closed: ${reason}`,
        suspendedAt: now,
        suspendedById: adminId,
        tokenVersion: { increment: 1 },
      },
    });
  });

  await recordAudit({
    actorId: adminId,
    action: "vendor.close",
    entityType: "Vendor",
    entityId: vendorId,
    reason,
    beforeState: { closedAt: null, isSuspended: vendor.isSuspended, storeName: vendor.storeName },
    afterState: { closedAt: now.toISOString(), isSuspended: true, anonymised: true },
    request,
    failClosed: true,
  });

  response.status(200).json({ closed: true, closedAt: now });
}
