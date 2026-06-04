import { NotificationType, UserRole } from "@prisma/client";

import { sendPushToUser } from "../../lib/expo-push";
import { prisma } from "../../lib/prisma";
import { sendSms } from "../../lib/sms";
import { AppError } from "../../shared/errors/app-error";

type BroadcastAudience = "all" | "vendors" | "buyers" | "active_vendors" | "new_vendors" | "individual_vendor" | "individual_buyer";
type BroadcastChannel = "in_app" | "push" | "sms" | "in_app_push" | "in_app_sms" | "in_app_push_sms";

export interface AdminBroadcastInput {
  audience: BroadcastAudience;
  channel: BroadcastChannel;
  subject: string;
  body: string;
  vendorId?: string;
  userId?: string;
}

const VALID_AUDIENCES = new Set<BroadcastAudience>(["all", "vendors", "buyers", "active_vendors", "new_vendors", "individual_vendor", "individual_buyer"]);
const VALID_CHANNELS = new Set<BroadcastChannel>(["in_app", "push", "sms", "in_app_push", "in_app_sms", "in_app_push_sms"]);

function normalizeInput(raw: unknown): AdminBroadcastInput {
  const input = (raw ?? {}) as Partial<AdminBroadcastInput>;
  const audience = input.audience ?? "all";
  const channel = input.channel ?? "in_app_push";
  const rawSubject = input.subject ?? (raw as { title?: unknown } | null)?.title;
  const subject = typeof rawSubject === "string" ? rawSubject.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const vendorId = typeof input.vendorId === "string" ? input.vendorId.trim() : undefined;
  const userId = typeof input.userId === "string" ? input.userId.trim() : undefined;

  if (!VALID_AUDIENCES.has(audience)) throw new AppError("Invalid broadcast audience", 400);
  if (!VALID_CHANNELS.has(channel)) throw new AppError("Invalid broadcast channel", 400);
  if (!subject) throw new AppError("Broadcast subject is required", 400);
  if (!body) throw new AppError("Broadcast body is required", 400);
  if (subject.length > 120) throw new AppError("Broadcast subject is too long", 400);
  if (body.length > 1000) throw new AppError("Broadcast body is too long", 400);
  if (audience === "individual_vendor" && !vendorId) throw new AppError("vendorId is required for individual vendor broadcasts", 400);
  if (audience === "individual_buyer" && !userId) throw new AppError("userId is required for individual buyer broadcasts", 400);

  return { audience, channel, subject, body, vendorId, userId };
}

function whereForAudience(audience: BroadcastAudience) {
  if (audience === "buyers") return { role: UserRole.BUYER, isSuspended: false };
  if (audience === "vendors") return { role: UserRole.VENDOR, isSuspended: false };
  if (audience === "active_vendors") return { role: UserRole.VENDOR, isSuspended: false, vendor: { isSuspended: false } };
  if (audience === "new_vendors") {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return { role: UserRole.VENDOR, isSuspended: false, createdAt: { gte: sevenDaysAgo } };
  }
  return { isSuspended: false };
}

export const adminCommunicationsService = {
  normalizeInput,

  async broadcast(actorId: string, input: AdminBroadcastInput) {
    const recipients = input.audience === "individual_vendor"
      ? await prisma.user.findMany({
          where: { vendor: { id: input.vendorId }, role: UserRole.VENDOR, isSuspended: false },
          select: { id: true, role: true, phone: true, smsMarketingConsentAt: true },
          take: 1,
        })
      : input.audience === "individual_buyer"
        ? await prisma.user.findMany({
            where: { id: input.userId, role: UserRole.BUYER, isSuspended: false },
            select: { id: true, role: true, phone: true, smsMarketingConsentAt: true },
            take: 1,
          })
        : await prisma.user.findMany({
            where: whereForAudience(input.audience),
            select: { id: true, role: true, phone: true, smsMarketingConsentAt: true },
            take: 1000,
          });

    const shouldCreateMessages = ["in_app", "in_app_push", "in_app_sms", "in_app_push_sms"].includes(input.channel);
    const shouldPush = ["push", "in_app_push", "in_app_push_sms"].includes(input.channel);
    const shouldSms = ["sms", "in_app_sms", "in_app_push_sms"].includes(input.channel);

    let notificationsCreated = 0;
    if (recipients.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const recipient of recipients) {
          if (recipient.id === actorId) continue;
          await tx.notification.create({
            data: {
              userId: recipient.id,
              type: NotificationType.ADMIN_BROADCAST,
              title: input.subject,
              body: input.body,
              data: { source: "admin", channel: input.channel, audience: input.audience },
            },
          });
          notificationsCreated += 1;
        }
      });
    }

    let messageCount = 0;
    if (shouldCreateMessages && recipients.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const recipient of recipients) {
          if (recipient.id === actorId) continue;
          const [participantA, participantB] = actorId < recipient.id ? [actorId, recipient.id] : [recipient.id, actorId];
          const conversation = await tx.conversation.upsert({
            where: {
              participantA_participantB_orderId: {
                participantA,
                participantB,
                orderId: "",
              },
            },
            create: {
              participantA,
              participantB,
              orderId: "",
              type: recipient.role === UserRole.VENDOR ? "ADMIN_VENDOR" : "BUYER_VENDOR",
              lastMessageAt: new Date(),
            },
            update: { lastMessageAt: new Date() },
          });
          await tx.message.create({
            data: {
              conversationId: conversation.id,
              senderId: actorId,
              text: `${input.subject}\n\n${input.body}`,
            },
          });
          messageCount += 1;
        }
      });
    }

    if (shouldPush) {
      for (const recipient of recipients) {
        if (recipient.id === actorId) continue;
        void sendPushToUser(recipient.id, {
          title: input.subject,
          body: input.body,
          data: { type: "admin_broadcast", audience: input.audience },
        });
      }
    }

    let smsQueued = 0;
    let smsSkipped = 0;
    if (shouldSms) {
      for (const recipient of recipients) {
        if (recipient.id === actorId) continue;
        if (!recipient.phone || !recipient.smsMarketingConsentAt) {
          smsSkipped += 1;
          continue;
        }
        smsQueued += 1;
        void sendSms({
          to: recipient.phone,
          message: `${input.subject}: ${input.body}`,
          purpose: "admin_marketing",
        });
      }
    }

    return {
      sent: recipients.filter((recipient) => recipient.id !== actorId).length,
      queued: shouldPush ? recipients.length : 0,
      notificationsCreated,
      messagesCreated: messageCount,
      smsQueued,
      smsSkipped,
      message: "Admin broadcast queued successfully.",
    };
  },
};
