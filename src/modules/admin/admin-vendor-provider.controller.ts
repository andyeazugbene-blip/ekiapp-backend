import type { Request, Response } from "express";
import { NotificationType } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { notificationsService } from "../notifications/notifications.service";
import { stripeConnectService } from "../vendors/stripe-connect.service";
import { deriveVendorProviderReadiness, VENDOR_PROVIDER_SELECT } from "../vendors/vendor-provider-readiness";

const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function stripeBase(): string {
  // Dashboard mode follows the platform's own key, never a user-supplied value.
  const live = (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_live_");
  return `https://dashboard.stripe.com${live ? "" : "/test"}`;
}

async function loadReadiness(vendorId: string) {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, storeName: true, userId: true, stripeReminderSentAt: true, ...VENDOR_PROVIDER_SELECT },
  });
  if (!vendor) throw new AppError("Vendor not found", 404);
  const legacyDocs = await prisma.verificationDocument.count({ where: { vendorId, deletedAt: null } });
  const readiness = deriveVendorProviderReadiness(vendor, { hasLegacyDocuments: legacyDocs > 0 });
  const base = stripeBase();
  return {
    vendorId: vendor.id,
    storeName: vendor.storeName,
    reminderLastSentAt: vendor.stripeReminderSentAt,
    ...readiness,
    legacyDocumentCount: legacyDocs,
    // Handbook 14.3: deep links into the provider; null when Stripe holds nothing yet.
    links: {
      account: readiness.connect.accountId ? `${base}/connect/accounts/${readiness.connect.accountId}` : null,
      identitySession: readiness.identity.sessionId ? `${base}/identity/verification-sessions/${readiness.identity.sessionId}` : null,
    },
  };
}

/** GET /admin/vendors/:id/stripe-status[?refresh=true] */
export async function getVendorStripeStatus(request: Request, response: Response) {
  const vendorId = String(request.params.id);
  let refreshWarning: string | undefined;
  if (request.query.refresh === "true") {
    const result = await stripeConnectService.refreshFromStripeForAdmin(vendorId);
    refreshWarning = result.error;
  }
  const data = await loadReadiness(vendorId);
  response.json({ ...data, refreshWarning });
}

/**
 * POST /admin/vendors/:id/stripe-reminder
 * Handbook 5.1 L202-205: staff may send a secure onboarding/status reminder.
 * The reminder never carries a link or credentials; the vendor completes the
 * flow inside the app, where Stripe issues a fresh Account Link.
 */
export async function sendVendorStripeReminder(request: Request, response: Response) {
  const vendorId = String(request.params.id);
  const adminId = request.user?.id;
  if (!adminId) throw new AppError("Unauthorized", 401);
  const data = await loadReadiness(vendorId);

  if (data.stage === "VERIFIED") {
    throw new AppError("Nothing to remind: Stripe reports this vendor as fully verified.", 409);
  }
  if (data.reminderLastSentAt && Date.now() - new Date(data.reminderLastSentAt).getTime() < REMINDER_COOLDOWN_MS) {
    throw new AppError("A reminder was already sent in the last 24 hours.", 429);
  }

  const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { userId: true } });
  const waitingOnVendor = data.pendingOn === "VENDOR" || data.stage === "REQUIREMENTS_DUE" || data.stage === "NOT_STARTED";
  await notificationsService.enqueue({
    userId: vendor.userId,
    type: NotificationType.ADMIN_BROADCAST,
    title: waitingOnVendor ? "Finish your payout and verification setup" : "Your verification is being reviewed",
    body: waitingOnVendor
      ? "Open Eki > Payouts to continue Stripe verification so you can start receiving orders and payouts."
      : "Stripe is still reviewing your details. We'll tell you as soon as it's done.",
    data: { type: "stripe_onboarding_reminder", vendorId },
  });

  await prisma.vendor.update({ where: { id: vendorId }, data: { stripeReminderSentAt: new Date() } });
  await recordAudit({
    actorId: adminId,
    action: "vendor.stripe_reminder",
    entityType: "Vendor",
    entityId: vendorId,
    reason: "Secure onboarding/status reminder sent",
    afterState: { stage: data.stage, pendingOn: data.pendingOn },
    request,
  });
  response.json({ sent: true });
}
