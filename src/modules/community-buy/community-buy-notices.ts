import { enqueueEmail } from "../../lib/email-queue";
import { emailTemplates } from "../../lib/email-templates";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { notificationsService } from "../notifications/notifications.service";

/**
 * Handbook 14.11 / 10.3 - one shared "tell this person, in-app and by email"
 * helper for Community Buy admin decisions. Best effort: never throws, so a
 * notification failure can never undo the business transaction that already
 * succeeded. In-app dedupe is delegated to notificationsService (dedupeKey).
 */
export async function notifyUserInAppAndEmail(input: {
  userId: string;
  title: string;
  body: string;
  event: string;
  data?: Record<string, unknown>;
  dedupeKey?: string;
  channels?: { email?: boolean };
}): Promise<void> {
  try {
    await notificationsService.enqueue({
      userId: input.userId,
      type: "ADMIN_BROADCAST",
      title: input.title,
      body: input.body,
      data: { type: "community_buy_notice", event: input.event, ...(input.data ?? {}) } as never,
      dedupeKey: input.dedupeKey,
    });
    if (input.channels?.email === false) return;
    const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { email: true } });
    if (!user?.email) return;
    const template = emailTemplates.adminBroadcast({ subject: input.title, body: input.body });
    await enqueueEmail({ to: user.email, subject: template.subject, html: template.html });
  } catch (error) {
    logger.error("Community Buy notice failed (non-blocking)", {
      event: input.event,
      userId: input.userId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
