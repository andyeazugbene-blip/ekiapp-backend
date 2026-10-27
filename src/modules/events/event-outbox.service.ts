import type { Event, Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { EVENT_NAMES, type EmitEventInput } from "./events.service";
import { ensureCriticalIncidentCandidates, criticalIncidentAlertsEnabled, materializeOpenCriticalIncidents } from "../ledger/critical-incident-notifications";
import { recordNotificationOutcomes } from "../notifications/notification-outcomes";

const MAX_ATTEMPTS = 8;
const STALE_LOCK_MS = 5 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

export type EventOutboxHandler = (tx: Prisma.TransactionClient, event: Event) => Promise<void>;
export type EventOutboxHandlers = Partial<Record<string, EventOutboxHandler>>;
const registeredHandlers: Record<string, EventOutboxHandler> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate the versioned envelope before it enters or leaves the outbox. */
export function validateOutboxEvent(input: Pick<EmitEventInput, "name" | "payload" | "occurredAt"> & { schemaVersion: number }): void {
  if (!Object.values(EVENT_NAMES).includes(input.name as never)) throw new AppError("Unknown canonical event name", 400);
  if (input.schemaVersion !== 1) throw new AppError(`Unsupported event schema version: ${input.schemaVersion}`, 400);
  if (input.payload != null && !isRecord(input.payload)) throw new AppError("Event payload must be an object", 400);
  if (input.occurredAt && Number.isNaN(input.occurredAt.getTime())) throw new AppError("Event occurredAt must be a valid date", 400);
}

function retryDelayMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

export const eventOutboxService = {
  registerHandler(name: string, handler: EventOutboxHandler): void {
    if (!Object.values(EVENT_NAMES).includes(name as never)) throw new AppError("Unknown canonical event name", 400);
    if (registeredHandlers[name]) throw new AppError(`An outbox handler is already registered for ${name}`, 409);
    registeredHandlers[name] = handler;
  },

  async dispatchRegisteredBatch(limit = 50, now = new Date()) {
    return eventOutboxService.dispatchBatch({ ...registeredHandlers }, limit, now);
  },

  /**
   * Persist a versioned event in the caller's business transaction. The
   * dedupe key is required so transaction retries cannot create duplicate
   * outbox rows. Handler side effects must be database-only and use the tx
   * passed by the dispatcher; network delivery belongs after candidate
   * creation in a separate retryable delivery stage.
   */
  async enqueue(tx: Prisma.TransactionClient, input: EmitEventInput, options: { dedupeKey: string; schemaVersion?: number }): Promise<Event> {
    const schemaVersion = options.schemaVersion ?? 1;
    validateOutboxEvent({ ...input, schemaVersion });
    if (!options.dedupeKey.trim()) throw new AppError("Outbox dedupeKey is required", 400);

    const data: Prisma.EventCreateInput = {
      name: input.name,
      schemaVersion,
      dedupeKey: options.dedupeKey,
      deliveryStatus: "PENDING",
      occurredAt: input.occurredAt ?? new Date(),
      timezone: input.timezone ?? "UTC",
      actorType: input.actorType ?? null,
      actorId: input.actorId ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      secondaryEntities: input.secondaryEntities as Prisma.InputJsonValue | undefined,
      source: input.source ?? null,
      consentContext: input.consentContext as Prisma.InputJsonValue | undefined,
      amountMinor: input.amountMinor == null ? null : Math.round(input.amountMinor),
      currency: input.currency ?? null,
      payload: input.payload as Prisma.InputJsonValue | undefined,
    };
    return tx.event.upsert({ where: { dedupeKey: options.dedupeKey }, create: data, update: {} });
  },

  /**
   * At-least-once, lease-based consumer. Candidate creation and the DELIVERED
   * transition share one DB transaction, so a crash cannot commit one
   * without the other. Stale leases are recovered on the next sweep.
   */
  async dispatchBatch(handlers: EventOutboxHandlers, limit = 50, now = new Date()): Promise<{ claimed: number; delivered: number; retried: number; dead: number; unhandled: number }> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
    await prisma.event.updateMany({
      where: { deliveryStatus: "PROCESSING", lockedAt: { lt: staleBefore } },
      data: { deliveryStatus: "PENDING", lockedAt: null, availableAt: now },
    });

    const due = await prisma.event.findMany({
      where: { deliveryStatus: "PENDING", availableAt: { lte: now } },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
      take: boundedLimit,
    });
    const result = { claimed: 0, delivered: 0, retried: 0, dead: 0, unhandled: 0 };

    for (const candidate of due) {
      const handler = handlers[candidate.name];
      if (!handler) {
        result.unhandled += 1;
        continue;
      }
      const claimed = await prisma.event.updateMany({
        where: { id: candidate.id, deliveryStatus: "PENDING", availableAt: { lte: now } },
        data: { deliveryStatus: "PROCESSING", lockedAt: now, deliveryAttempt: { increment: 1 } },
      });
      if (!claimed.count) continue;
      result.claimed += 1;

      try {
        validateOutboxEvent({ name: candidate.name, payload: candidate.payload as Record<string, unknown> | null, occurredAt: candidate.occurredAt, schemaVersion: candidate.schemaVersion });
        const handled = await prisma.$transaction(async (tx) => {
          // Lock the claimed row so lease recovery cannot reclaim it while a
          // database-only handler transaction is still producing candidates.
          const locked = await tx.event.updateMany({
            where: { id: candidate.id, deliveryStatus: "PROCESSING", lockedAt: now },
            data: { lockedAt: now },
          });
          if (!locked.count) return false;
          const current = await tx.event.findUnique({ where: { id: candidate.id } });
          if (!current || current.deliveryStatus !== "PROCESSING") return false;
          await handler(tx, current);
          await recordNotificationOutcomes(tx, current);
          await tx.event.update({
            where: { id: current.id },
            data: { deliveryStatus: "DELIVERED", deliveredAt: now, lockedAt: null, lastDeliveryError: null },
          });
          return true;
        });
        if (handled) result.delivered += 1;
      } catch (error) {
        const attempt = candidate.deliveryAttempt + 1;
        const dead = attempt >= MAX_ATTEMPTS || error instanceof AppError;
        const failure = errorText(error);
        if (dead) {
          await prisma.$transaction(async (tx) => {
            const marked = await tx.event.updateMany({
              where: { id: candidate.id, deliveryStatus: "PROCESSING" },
              data: { deliveryStatus: "DEAD", lockedAt: null, availableAt: now, lastDeliveryError: failure },
            });
            if (!marked.count) return;
            const dedupeKey = `OUTBOX_EVENT_FAILURE:${candidate.id}`;
            const incident = await tx.paymentAnomaly.upsert({
              where: { dedupeKey },
              update: { evidence: { eventId: candidate.id, eventName: candidate.name, attempts: attempt, error: failure }, lastSeenAt: now },
              create: {
                kind: "OUTBOX_EVENT_FAILURE", severity: "CRITICAL", dedupeKey,
                businessRefType: "Event", businessRefId: candidate.id,
                evidence: { eventId: candidate.id, eventName: candidate.name, attempts: attempt, error: failure },
              },
            });
            if (criticalIncidentAlertsEnabled()) await ensureCriticalIncidentCandidates(tx, incident);
          });
        } else {
          await prisma.event.updateMany({
            where: { id: candidate.id, deliveryStatus: "PROCESSING" },
            data: { deliveryStatus: "PENDING", lockedAt: null, availableAt: new Date(now.getTime() + retryDelayMs(attempt)), lastDeliveryError: failure },
          });
        }
        if (dead) result.dead += 1;
        else result.retried += 1;
      }
    }
    if (criticalIncidentAlertsEnabled()) {
      try { await materializeOpenCriticalIncidents(boundedLimit); }
      catch (error) { logger.warn("Critical incident notification materialization failed", { error: errorText(error) }); }
    }
    return result;
  },
};
