import type { Prisma } from "@prisma/client";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";

/**
 * Canonical event names (handbook section 12). Business meaning must stay
 * stable — add names, never repurpose one. Domain prefix is dropped for the
 * handbook's flat names; names the handbook scopes to a domain (Subscription:
 * "paused", Community Buy: "joined", Communication: "queued"...) are prefixed
 * with that domain so they stay unambiguous in one table.
 */
export const EVENT_NAMES = {
  // Merchant activation
  merchant_registered: "merchant_registered",
  verification_completed: "verification_completed",
  store_ready: "store_ready",
  product_published: "product_published",
  delivery_configured: "delivery_configured",
  // Discovery
  campaign_created: "campaign_created",
  campaign_approved: "campaign_approved",
  campaign_launched: "campaign_launched",
  campaign_impression: "campaign_impression",
  store_viewed: "store_viewed",
  product_viewed: "product_viewed",
  // Conversion
  cart_created: "cart_created",
  item_added_to_cart: "item_added_to_cart",
  checkout_started: "checkout_started",
  payment_succeeded: "payment_succeeded",
  payment_failed: "payment_failed",
  // Order
  order_created: "order_created",
  order_accepted: "order_accepted",
  order_dispatched: "order_dispatched",
  order_delivered: "order_delivered",
  order_completed: "order_completed",
  order_refunded: "order_refunded",
  // Automation
  automation_eligible: "automation_eligible",
  automation_triggered: "automation_triggered",
  automation_suppressed: "automation_suppressed",
  automation_actioned: "automation_actioned",
  automation_clicked: "automation_clicked",
  // Referral
  referral_created: "referral_created",
  invitation_opened: "invitation_opened",
  referred_account_created: "referred_account_created",
  referral_store_ready: "referral_store_ready",
  referral_qualified: "referral_qualified",
  reward_released: "reward_released",
  reward_reversed: "reward_reversed",
  // Subscription
  subscription_created: "subscription_created",
  renewal_due: "renewal_due",
  payment_retry: "payment_retry",
  order_generated: "order_generated",
  subscription_skipped: "subscription_skipped",
  subscription_paused: "subscription_paused",
  subscription_resumed: "subscription_resumed",
  subscription_cancelled: "subscription_cancelled",
  subscription_renewed: "subscription_renewed",
  subscription_payment_failed: "subscription_payment_failed",
  vendor_trial_ending: "vendor_trial_ending",
  // Community Buy
  community_buy_created: "community_buy_created",
  community_buy_approved: "community_buy_approved",
  community_buy_published: "community_buy_published",
  community_buy_joined: "community_buy_joined",
  community_buy_target_reached: "community_buy_target_reached",
  community_buy_target_failed: "community_buy_target_failed",
  community_buy_refund_started: "community_buy_refund_started",
  community_buy_fulfilled: "community_buy_fulfilled",
  community_buy_completed: "community_buy_completed",
  // Dispute (handbook 11) - additive
  dispute_opened: "dispute_opened",
  dispute_evidence_submitted: "dispute_evidence_submitted",
  dispute_resolved: "dispute_resolved",
  dispute_appealed: "dispute_appealed",
  dispute_appeal_decided: "dispute_appeal_decided",
  // Delivery proof (handbook 11) - additive
  delivery_proof_submitted: "delivery_proof_submitted",
  // Refund (admin / dispute-driven refunds of orders)
  refund_requested: "refund_requested",
  refund_completed: "refund_completed",
  // Communication
  message_drafted: "message_drafted",
  message_test_sent: "message_test_sent",
  message_queued: "message_queued",
  message_delivered: "message_delivered",
  message_failed: "message_failed",
  message_opened: "message_opened",
  message_clicked: "message_clicked",
  message_opted_out: "message_opted_out",
} as const;

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

export interface EmitEventInput {
  name: EventName | string;
  occurredAt?: Date;
  timezone?: string;
  actorType?: "user" | "vendor" | "admin" | "system" | "stripe" | string;
  actorId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  secondaryEntities?: Record<string, unknown> | null;
  source?: string | null;
  consentContext?: Record<string, unknown> | null;
  amountMinor?: number | null;
  currency?: string | null;
  payload?: Record<string, unknown> | null;
}

function toInt(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  // Event.amountMinor is a 32-bit column; refuse to store a value that would overflow.
  return Math.abs(n) <= 2_147_483_647 ? n : null;
}

async function persist(input: EmitEventInput): Promise<void> {
  await prisma.event.create({
    data: {
      name: input.name,
      occurredAt: input.occurredAt ?? new Date(),
      timezone: input.timezone ?? "UTC",
      actorType: input.actorType ?? null,
      actorId: input.actorId ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      secondaryEntities: (input.secondaryEntities ?? undefined) as Prisma.InputJsonValue | undefined,
      source: input.source ?? null,
      consentContext: (input.consentContext ?? undefined) as Prisma.InputJsonValue | undefined,
      amountMinor: toInt(input.amountMinor),
      currency: input.currency ?? null,
      payload: (input.payload ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

function logEmitFailure(name: string, error: unknown): void {
  try {
    logger.warn("Event emit failed", { name, error: error instanceof Error ? error.message : String(error) });
  } catch {
    // logging must never turn a swallowed event failure into an unhandled rejection
  }
}

export const eventsService = {
  /**
   * Fire-and-forget. Returns void synchronously; the DB write is not awaited by
   * the caller and any failure (including a synchronous throw) is swallowed and
   * logged. Never put this on the critical path of a business operation.
   */
  emit(input: EmitEventInput): void {
    try {
      void persist(input).catch((error) => {
        logEmitFailure(input.name, error);
      });
    } catch (error) {
      logEmitFailure(input.name, error);
    }
  },

  /** Awaitable variant for tests and scripts; still never throws. */
  async emitAndWait(input: EmitEventInput): Promise<boolean> {
    try {
      await persist(input);
      return true;
    } catch (error) {
      logEmitFailure(input.name, error);
      return false;
    }
  },

  async list(params: { name?: string; entityType?: string; entityId?: string; actorId?: string; from?: Date; to?: Date; limit?: number; cursor?: string }) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const where: Prisma.EventWhereInput = {};
    if (params.name) where.name = params.name;
    if (params.entityType) where.entityType = params.entityType;
    if (params.entityId) where.entityId = params.entityId;
    if (params.actorId) where.actorId = params.actorId;
    if (params.from || params.to) where.occurredAt = { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) };
    const rows = await prisma.event.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  },

  async names(): Promise<string[]> {
    const rows = await prisma.event.groupBy({ by: ["name"], _count: { id: true }, orderBy: { name: "asc" } });
    return rows.map((r) => r.name);
  },
};
