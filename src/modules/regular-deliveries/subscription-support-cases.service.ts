import type { SubscriptionSupportCaseType, SupportCaseStatus } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { notificationsService } from "../notifications/notifications.service";

const CASE_TYPES: SubscriptionSupportCaseType[] = ["PAYMENT", "RENEWAL", "PRICE_CHANGE", "STOCK", "DELIVERY", "CANCELLATION", "REFUND", "VENDOR_CONDUCT"];
const CASE_STATUSES: SupportCaseStatus[] = ["OPEN", "IN_PROGRESS", "ESCALATED", "RESOLVED", "CLOSED"];

function evidence(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((u) => typeof u !== "string" || !/^https:\/\//.test(u))) {
    throw new AppError("Evidence must be a list of https links", 400, undefined, "INVALID_EVIDENCE");
  }
  return raw as string[];
}

function optionalText(raw: unknown, field: string): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") throw new AppError(`${field} must be text`, 400);
  return raw.trim() || null;
}

export const subscriptionSupportCasesService = {
  async list(subscriptionId: string) {
    return prisma.subscriptionSupportCase.findMany({ where: { subscriptionId }, orderBy: { createdAt: "desc" }, take: 50 });
  },

  async create(adminId: string, subscriptionId: string, input: Record<string, unknown>) {
    const caseType = input.caseType as SubscriptionSupportCaseType;
    if (!CASE_TYPES.includes(caseType)) throw new AppError("Choose a case type", 400, undefined, "INVALID_CASE_TYPE");
    const description = typeof input.description === "string" ? input.description.trim() : "";
    if (!description) throw new AppError("Describe the case", 400, undefined, "DESCRIPTION_REQUIRED");
    const subscription = await prisma.buyerSubscription.findUnique({ where: { id: subscriptionId }, select: { id: true } });
    if (!subscription) throw new AppError("Subscription not found", 404);
    const renewalId = typeof input.renewalId === "string" && input.renewalId ? input.renewalId : null;
    if (renewalId) {
      const renewal = await prisma.renewal.findFirst({ where: { id: renewalId, subscriptionId }, select: { id: true } });
      if (!renewal) throw new AppError("That renewal isn't part of this subscription", 400, undefined, "RENEWAL_MISMATCH");
    }
    const created = await prisma.subscriptionSupportCase.create({
      data: {
        subscriptionId,
        renewalId,
        caseType,
        description,
        evidenceUrls: evidence(input.evidenceUrls),
        internalNotes: optionalText(input.internalNotes, "internalNotes") ?? null,
        createdById: adminId,
      },
    });
    await recordAudit({ actorId: adminId, action: "subscription_support_case.created", entityType: "SubscriptionSupportCase", entityId: created.id, metadata: { subscriptionId, caseType } });
    return created;
  },

  async update(adminId: string, caseId: string, input: Record<string, unknown>) {
    const existing = await prisma.subscriptionSupportCase.findUnique({ where: { id: caseId }, include: { subscription: { select: { buyerId: true } } } });
    if (!existing) throw new AppError("Support case not found", 404);
    const status = input.status as SupportCaseStatus | undefined;
    if (status !== undefined && !CASE_STATUSES.includes(status)) throw new AppError("Unknown case status", 400, undefined, "INVALID_CASE_STATUS");
    const escalate = input.escalate === true;
    const response = optionalText(input.customerVisibleResponse, "customerVisibleResponse");
    const finishing = status === "RESOLVED" || status === "CLOSED";
    const updated = await prisma.subscriptionSupportCase.update({
      where: { id: caseId },
      data: {
        ...(status ? { status } : {}),
        ...(input.internalNotes !== undefined ? { internalNotes: optionalText(input.internalNotes, "internalNotes") } : {}),
        ...(response !== undefined ? { customerVisibleResponse: response } : {}),
        ...(input.evidenceUrls !== undefined ? { evidenceUrls: evidence(input.evidenceUrls) } : {}),
        ...(escalate ? { escalated: true, escalatedAt: new Date(), status: "ESCALATED" as const } : {}),
        ...(finishing ? { resolvedById: adminId, resolvedAt: new Date() } : {}),
      },
    });
    await recordAudit({
      actorId: adminId,
      action: "subscription_support_case.updated",
      entityType: "SubscriptionSupportCase",
      entityId: caseId,
      beforeState: { status: existing.status, escalated: existing.escalated },
      afterState: { status: updated.status, escalated: updated.escalated },
    });
    // The buyer only hears about what's written for them, and only when it changes.
    if (response && response !== existing.customerVisibleResponse) {
      await notificationsService.enqueue({
        userId: existing.subscription.buyerId,
        type: "SUBSCRIPTION_UPDATE",
        title: "An update on your Foodstuff Subscription",
        body: response,
        data: { type: "subscription_update", event: "support_case_response", subscriptionId: existing.subscriptionId },
      });
    }
    return updated;
  },
};
