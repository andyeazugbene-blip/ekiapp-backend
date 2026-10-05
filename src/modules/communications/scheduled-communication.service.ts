import { BroadcastStatus } from "@prisma/client";

import { checkPushReceipts } from "../../lib/expo-push";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import {
  adminCommunicationsService,
  audienceParamsOf,
  selectedChannels,
  type AdminBroadcastInput,
} from "../admin/admin-communications.service";
import { commsPauseService } from "./comms-pause.service";

/** A claimed (SENDING) schedule untouched for this long is treated as interrupted. */
const STUCK_SENDING_MS = 15 * 60 * 1000;

export interface CreateScheduledInput {
  input: AdminBroadcastInput;
  reason: string;
  scheduledFor: string; // ISO date string
  createdBy: string;
}

export const scheduledCommunicationService = {
  /** Creates the Broadcast (SCHEDULED) and its schedule row together. */
  async create(args: CreateScheduledInput) {
    const scheduledDate = new Date(args.scheduledFor);
    if (isNaN(scheduledDate.getTime())) throw new AppError("Invalid scheduledFor date", 400);
    if (scheduledDate <= new Date()) throw new AppError("scheduledFor must be in the future", 400);
    const reason = (args.reason ?? "").trim();
    if (reason.length < 5) throw new AppError("A purpose/reason of at least 5 characters is required", 400);
    const { input } = args;

    return prisma.$transaction(async (tx) => {
      const broadcast = await tx.broadcast.create({
        data: {
          createdById: args.createdBy,
          status: BroadcastStatus.SCHEDULED,
          category: input.category,
          title: input.subject,
          body: input.body,
          deepLink: input.deepLink ?? null,
          templateKey: input.templateKey ?? null,
          audience: input.audience,
          audienceParams: audienceParamsOf(input),
          channels: selectedChannels(input),
          reason,
          scheduledFor: scheduledDate,
        },
      });
      return tx.scheduledCommunication.create({
        data: {
          audience: input.audience,
          channel: input.channel,
          channels: selectedChannels(input),
          category: input.category,
          deepLink: input.deepLink ?? null,
          templateKey: input.templateKey ?? null,
          audienceParams: audienceParamsOf(input),
          reason,
          subject: input.subject,
          body: input.body,
          scheduledFor: scheduledDate,
          createdBy: args.createdBy,
          broadcastId: broadcast.id,
          status: "SCHEDULED",
        },
      });
    });
  },

  async list(query?: { status?: string; limit?: number; offset?: number }) {
    const where: Record<string, unknown> = {};
    if (query?.status) where.status = query.status;

    const limit = Math.min(query?.limit ?? 50, 100);
    const skip = query?.offset ?? 0;

    const [items, total] = await Promise.all([
      prisma.scheduledCommunication.findMany({ where, orderBy: { scheduledFor: "asc" }, take: limit, skip }),
      prisma.scheduledCommunication.count({ where }),
    ]);

    return { items, total };
  },

  async cancel(id: string) {
    const item = await prisma.scheduledCommunication.findUnique({ where: { id } });
    if (!item) throw new AppError("Scheduled communication not found", 404);
    // Atomic: only a still-SCHEDULED row can be cancelled, so a cancel can never
    // race a runner that has already claimed it.
    const claimed = await prisma.scheduledCommunication.updateMany({
      where: { id, status: "SCHEDULED" },
      data: { status: "CANCELLED" },
    });
    if (claimed.count === 0) throw new AppError("Only SCHEDULED items can be cancelled", 400);
    if (item.broadcastId) {
      await prisma.broadcast.updateMany({
        where: { id: item.broadcastId, status: BroadcastStatus.SCHEDULED },
        data: { status: BroadcastStatus.CANCELLED },
      });
    }
    return prisma.scheduledCommunication.findUnique({ where: { id } });
  },

  async update(id: string, input: { subject?: string; body?: string; scheduledFor?: string; deepLink?: string }) {
    const item = await prisma.scheduledCommunication.findUnique({ where: { id } });
    if (!item) throw new AppError("Scheduled communication not found", 404);
    if (item.status !== "SCHEDULED") throw new AppError("Only SCHEDULED items can be edited", 400);

    const data: Record<string, unknown> = {};
    if (typeof input.subject === "string" && input.subject.trim()) data.subject = input.subject.trim();
    if (typeof input.body === "string" && input.body.trim()) data.body = input.body.trim();
    if (typeof input.scheduledFor === "string" && input.scheduledFor) {
      const when = new Date(input.scheduledFor);
      if (isNaN(when.getTime())) throw new AppError("Invalid scheduledFor date", 400);
      if (when <= new Date()) throw new AppError("scheduledFor must be in the future", 400);
      data.scheduledFor = when;
    }
    if (Object.keys(data).length === 0) throw new AppError("Nothing to update", 400);

    const updated = await prisma.scheduledCommunication.updateMany({ where: { id, status: "SCHEDULED" }, data });
    if (updated.count === 0) throw new AppError("Only SCHEDULED items can be edited", 400);
    if (item.broadcastId) {
      await prisma.broadcast.updateMany({
        where: { id: item.broadcastId, status: BroadcastStatus.SCHEDULED },
        data: {
          ...(data.subject ? { title: data.subject as string } : {}),
          ...(data.body ? { body: data.body as string } : {}),
          ...(data.scheduledFor ? { scheduledFor: data.scheduledFor as Date } : {}),
        },
      });
    }
    return prisma.scheduledCommunication.findUnique({ where: { id } });
  },

  /**
   * Sends every schedule whose time has come. Claim semantics (no double send):
   *   SCHEDULED --(atomic updateMany)--> SENDING --(only after delivery)--> SENT | FAILED
   * A runner that dies mid-send leaves SENDING, which is later marked FAILED
   * (never silently re-sent). Honours scheduledFor: nothing early, and while the
   * emergency pause is on nothing is claimed at all.
   */
  async runDue(): Promise<{ processed: number; sent: number; failed: number; paused?: boolean; interrupted?: number }> {
    if (await commsPauseService.isCommsPaused()) {
      logger.info("Scheduled communications skipped: emergency_pause");
      return { processed: 0, sent: 0, failed: 0, paused: true };
    }

    const stuck = await prisma.scheduledCommunication.updateMany({
      where: { status: "SENDING", updatedAt: { lt: new Date(Date.now() - STUCK_SENDING_MS) } },
      data: { status: "FAILED", error: "Interrupted while sending; not retried automatically to avoid duplicate delivery" },
    });

    const now = new Date();
    const dueItems = await prisma.scheduledCommunication.findMany({
      where: { status: "SCHEDULED", scheduledFor: { lte: now } },
      orderBy: { scheduledFor: "asc" },
      take: 50,
    });

    let sent = 0;
    let failed = 0;

    for (const item of dueItems) {
      const claimed = await prisma.scheduledCommunication.updateMany({
        where: { id: item.id, status: "SCHEDULED" },
        data: { status: "SENDING" },
      });
      if (claimed.count === 0) continue; // already claimed by another runner / cancelled

      let broadcastId = item.broadcastId;
      try {
        if (!broadcastId) {
          // Legacy row created before Broadcast records existed.
          const input = adminCommunicationsService.normalizeInput({
            audience: item.audience, channel: item.channel, subject: item.subject, body: item.body,
          });
          const created = await prisma.broadcast.create({
            data: {
              createdById: item.createdBy, status: BroadcastStatus.SCHEDULED, category: input.category,
              title: input.subject, body: input.body, audience: input.audience, audienceParams: audienceParamsOf(input),
              channels: selectedChannels(input), reason: "Scheduled communication (legacy record)", scheduledFor: item.scheduledFor,
            },
          });
          broadcastId = created.id;
          await prisma.scheduledCommunication.update({ where: { id: item.id }, data: { broadcastId } });
        }
        const claimBroadcast = await prisma.broadcast.updateMany({
          where: { id: broadcastId, status: BroadcastStatus.SCHEDULED },
          data: { status: BroadcastStatus.SENDING, startedAt: new Date() },
        });
        if (claimBroadcast.count === 0) throw new Error("Broadcast was cancelled or already sent");

        const { status } = await adminCommunicationsService.executeBroadcast(broadcastId);
        if (status === BroadcastStatus.FAILED) {
          const b = await prisma.broadcast.findUnique({ where: { id: broadcastId }, select: { error: true } });
          await prisma.scheduledCommunication.update({
            where: { id: item.id },
            data: { status: "FAILED", error: b?.error ?? "Delivery failed on every channel" },
          });
          failed++;
        } else {
          // SENT only after delivery actually completed.
          await prisma.scheduledCommunication.update({
            where: { id: item.id },
            data: { status: "SENT", sentAt: new Date() },
          });
          sent++;
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error("Scheduled communication send failed", { id: item.id, error: errMsg });
        if (broadcastId) {
          await prisma.broadcast.updateMany({
            where: { id: broadcastId, status: { in: [BroadcastStatus.SENDING, BroadcastStatus.SCHEDULED] } },
            data: { status: BroadcastStatus.FAILED, error: errMsg, completedAt: new Date() },
          });
        }
        await prisma.scheduledCommunication.update({ where: { id: item.id }, data: { status: "FAILED", error: errMsg } });
        failed++;
      }
    }

    return { processed: dueItems.length, sent, failed, interrupted: stuck.count };
  },

  /**
   * 5-minute sweep: send due schedules, then pull real Expo push receipts and
   * refresh broadcast statuses (SENT -> Partially delivered if receipts failed).
   */
  async sweep() {
    const run = await scheduledCommunicationService.runDue();
    const receipts = await checkPushReceipts();
    const reconciled = await adminCommunicationsService.reconcileRecentBroadcasts();
    return { ...run, receipts, reconciled } as Record<string, unknown>;
  },
};

