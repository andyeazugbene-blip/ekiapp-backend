import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { adminCommunicationsService, AdminBroadcastInput } from "../admin/admin-communications.service";

export interface CreateScheduledInput {
  audience: string;
  channel: string;
  templateKey?: string;
  subject: string;
  body: string;
  scheduledFor: string; // ISO date string
  createdBy: string;
}

export const scheduledCommunicationService = {
  async create(input: CreateScheduledInput) {
    const scheduledDate = new Date(input.scheduledFor);
    if (isNaN(scheduledDate.getTime())) throw new AppError("Invalid scheduledFor date", 400);
    if (scheduledDate <= new Date()) throw new AppError("scheduledFor must be in the future", 400);

    return prisma.scheduledCommunication.create({
      data: {
        audience: input.audience,
        channel: input.channel,
        templateKey: input.templateKey || null,
        subject: input.subject,
        body: input.body,
        scheduledFor: scheduledDate,
        createdBy: input.createdBy,
        status: "SCHEDULED",
      },
    });
  },

  async list(query?: { status?: string; limit?: number; offset?: number }) {
    const where: Record<string, unknown> = {};
    if (query?.status) where.status = query.status;

    const limit = Math.min(query?.limit ?? 50, 100);
    const skip = query?.offset ?? 0;

    const [items, total] = await Promise.all([
      prisma.scheduledCommunication.findMany({
        where,
        orderBy: { scheduledFor: "asc" },
        take: limit,
        skip,
      }),
      prisma.scheduledCommunication.count({ where }),
    ]);

    return { items, total };
  },

  async cancel(id: string) {
    const item = await prisma.scheduledCommunication.findUnique({ where: { id } });
    if (!item) throw new AppError("Scheduled communication not found", 404);
    if (item.status !== "SCHEDULED") throw new AppError("Only SCHEDULED items can be cancelled", 400);

    return prisma.scheduledCommunication.update({
      where: { id },
      data: { status: "CANCELLED" },
    });
  },

  async update(id: string, input: { subject?: string; body?: string; scheduledFor?: string; audience?: string; channel?: string }) {
    const item = await prisma.scheduledCommunication.findUnique({ where: { id } });
    if (!item) throw new AppError("Scheduled communication not found", 404);
    if (item.status !== "SCHEDULED") throw new AppError("Only SCHEDULED items can be edited", 400);

    const data: Record<string, unknown> = {};
    if (typeof input.subject === "string" && input.subject.trim()) data.subject = input.subject.trim();
    if (typeof input.body === "string" && input.body.trim()) data.body = input.body.trim();
    if (typeof input.audience === "string" && input.audience.trim()) data.audience = input.audience.trim();
    if (typeof input.channel === "string" && input.channel.trim()) data.channel = input.channel.trim();
    if (typeof input.scheduledFor === "string" && input.scheduledFor) {
      const when = new Date(input.scheduledFor);
      if (isNaN(when.getTime())) throw new AppError("Invalid scheduledFor date", 400);
      data.scheduledFor = when;
    }
    if (Object.keys(data).length === 0) throw new AppError("Nothing to update", 400);

    return prisma.scheduledCommunication.update({ where: { id }, data });
  },

  async runDue(): Promise<{ processed: number; sent: number; failed: number }> {
    const now = new Date();
    const dueItems = await prisma.scheduledCommunication.findMany({
      where: {
        status: "SCHEDULED",
        scheduledFor: { lte: now },
      },
      orderBy: { scheduledFor: "asc" },
      take: 50,
    });

    let sent = 0;
    let failed = 0;

    for (const item of dueItems) {
      // Idempotency: atomically claim this item
      const claimed = await prisma.scheduledCommunication.updateMany({
        where: { id: item.id, status: "SCHEDULED" },
        data: { status: "SENT" },
      });
      if (claimed.count === 0) continue; // already claimed by another runner

      try {
        const broadcastInput: AdminBroadcastInput = {
          audience: item.audience as AdminBroadcastInput["audience"],
          channel: item.channel as AdminBroadcastInput["channel"],
          subject: item.subject,
          body: item.body,
        };

        await adminCommunicationsService.broadcast(item.createdBy, broadcastInput);

        await prisma.scheduledCommunication.update({
          where: { id: item.id },
          data: { sentAt: new Date(), status: "SENT" },
        });
        sent++;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error("Scheduled communication send failed", { id: item.id, error: errMsg });
        await prisma.scheduledCommunication.update({
          where: { id: item.id },
          data: { status: "FAILED", error: errMsg },
        });
        failed++;
      }
    }

    return { processed: dueItems.length, sent, failed };
  },
};
