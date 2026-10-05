/**
 * Support-conversation retention (handbook 6.1 / gap "message retention
 * undefined").
 *
 * POLICY: a SUPPORT conversation is eligible for purge only when ALL hold:
 *   - status = CLOSED and closedAt is older than N days
 *   - it is not escalated
 *   - no pending content report targets one of its messages
 * N = AdminPlatformSetting "SUPPORT_RETENTION_DAYS" if set, else env
 * SUPPORT_RETENTION_DAYS, else SUPPORT_RETENTION_DEFAULT_DAYS (730 = 2 years).
 * N is floored at SUPPORT_RETENTION_MIN_DAYS (90) so a typo cannot wipe recent history.
 *
 * The sweep is a DRY RUN (counts only, nothing deleted) unless purging is
 * explicitly enabled: AdminPlatformSetting "SUPPORT_RETENTION_ENABLED" = 1, or
 * env SUPPORT_RETENTION_ENABLED=true. Messages are removed by the FK cascade.
 * Ordinary buyer<->vendor threads and admin-broadcast threads are never purged
 * here. Uploaded attachment files in storage are not deleted by this job.
 * Each run is capped at SUPPORT_RETENTION_BATCH conversations.
 */
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { recordAudit } from "../../shared/utils/audit";

export const SUPPORT_RETENTION_DEFAULT_DAYS = 730;
export const SUPPORT_RETENTION_MIN_DAYS = 90;
export const SUPPORT_RETENTION_BATCH = 200;
const DAYS_KEY = "SUPPORT_RETENTION_DAYS";
const ENABLED_KEY = "SUPPORT_RETENTION_ENABLED";

async function resolveConfig(): Promise<{ days: number; enabled: boolean }> {
  const rows = await prisma.adminPlatformSetting.findMany({ where: { key: { in: [DAYS_KEY, ENABLED_KEY] } } });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const envDays = Number(process.env.SUPPORT_RETENTION_DAYS);
  const configured = byKey.get(DAYS_KEY) ?? (Number.isFinite(envDays) && envDays > 0 ? envDays : SUPPORT_RETENTION_DEFAULT_DAYS);
  const days = Math.max(SUPPORT_RETENTION_MIN_DAYS, Math.floor(configured));
  const enabled = byKey.has(ENABLED_KEY) ? (byKey.get(ENABLED_KEY) ?? 0) >= 1 : process.env.SUPPORT_RETENTION_ENABLED === "true";
  return { days, enabled };
}

export const supportRetentionService = {
  async sweep(now: Date = new Date()): Promise<Record<string, unknown>> {
    const { days, enabled } = await resolveConfig();
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const reports = await prisma.contentReport.findMany({
      where: { targetType: "message", status: "PENDING" },
      select: { targetId: true },
      take: 2000,
    });
    const reportedMessages = reports.length
      ? await prisma.message.findMany({ where: { id: { in: reports.map((r) => r.targetId) } }, select: { conversationId: true } })
      : [];
    const protectedIds = Array.from(new Set(reportedMessages.map((m) => m.conversationId)));

    const candidates = await prisma.conversation.findMany({
      where: {
        type: "SUPPORT",
        status: "CLOSED",
        closedAt: { lt: cutoff },
        escalatedAt: null,
        ...(protectedIds.length ? { id: { notIn: protectedIds } } : {}),
      },
      select: { id: true },
      orderBy: { closedAt: "asc" },
      take: SUPPORT_RETENTION_BATCH,
    });

    if (!enabled || candidates.length === 0) {
      logger.info("Support retention sweep", { dryRun: !enabled, retentionDays: days, eligible: candidates.length });
      return { dryRun: !enabled, retentionDays: days, eligible: candidates.length, purged: 0 };
    }

    const ids = candidates.map((c) => c.id);
    const result = await prisma.conversation.deleteMany({ where: { id: { in: ids } } });
    await recordAudit({
      actorId: "system:support-retention",
      action: "support.retention.purged",
      entityType: "Conversation",
      metadata: { retentionDays: days, cutoff: cutoff.toISOString(), purged: result.count, conversationIds: ids },
    });
    logger.info("Support retention sweep purged conversations", { retentionDays: days, purged: result.count });
    return { dryRun: false, retentionDays: days, eligible: candidates.length, purged: result.count };
  },
};
