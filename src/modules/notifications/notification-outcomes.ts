import type { Event, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";

type CompletionMapping = { ruleId: string; entityType: string; payloadField: string };

const COMPLETION_MAPPINGS: Record<string, readonly CompletionMapping[]> = {
  verification_completed: [{ ruleId: "R07_VERIFICATION_REQUIRES_CORRECTION", entityType: "Vendor", payloadField: "vendorId" }],
  product_published: [{ ruleId: "R08_VERIFICATION_APPROVED", entityType: "Vendor", payloadField: "vendorId" }],
  order_accepted: [{ ruleId: "R12_FIRST_PAID_ORDER", entityType: "Order", payloadField: "orderId" }],
  order_delivered: [{ ruleId: "R22_ORDER_DISPATCHED", entityType: "Order", payloadField: "orderId" }],
  community_buy_minimum_reached: [{ ruleId: "R34_COMMUNITY_BUY_BELOW_MINIMUM", entityType: "CommunityCampaign", payloadField: "campaignId" }],
  payout_confirmed: [{ ruleId: "R25_PAYOUT_ACTION_REQUIRED", entityType: "Payout", payloadField: "payoutRequestId" }],
};

/** Record only source-backed completion transitions, within the same outbox transaction. */
export async function recordNotificationOutcomes(tx: Prisma.TransactionClient, event: Event): Promise<number> {
  const mappings = COMPLETION_MAPPINGS[event.name];
  if (!mappings) return 0;
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
  let updated = 0;
  for (const mapping of mappings) {
    const entityId = payload[mapping.payloadField];
    if (typeof entityId !== "string" || !entityId) continue;
    const candidates = await tx.notification.findMany({
      where: { ruleId: mapping.ruleId, entityType: mapping.entityType, entityId },
      select: { id: true },
    });
    for (const candidate of candidates) {
      await tx.notificationOutcome.upsert({
        where: { notificationId: candidate.id },
        create: {
          notificationId: candidate.id,
          completedAt: event.occurredAt,
          completionEventId: event.id,
          attributionModel: "DIRECT_TASK_COMPLETION",
        },
        update: {},
      });
      updated += 1;
    }
  }
  return updated;
}

/** Record a user-confirmed task completion when the domain signal is owner-authenticated. */
export async function recordNotificationTaskCompletion(input: {
  userId: string;
  ruleId: string;
  entityType: string;
  entityId: string;
  completedAt?: Date;
}): Promise<number> {
  const candidates = await prisma.notification.findMany({
    where: { userId: input.userId, ruleId: input.ruleId, entityType: input.entityType, entityId: input.entityId },
    select: { id: true },
  });
  const completedAt = input.completedAt ?? new Date();
  for (const candidate of candidates) {
    await prisma.notificationOutcome.upsert({
      where: { notificationId: candidate.id },
      create: { notificationId: candidate.id, completedAt, attributionModel: "DIRECT_TASK_COMPLETION" },
      update: {},
    });
  }
  return candidates.length;
}
