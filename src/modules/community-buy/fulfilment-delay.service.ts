import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";
import { adminPlatformSettingsService } from "../admin/admin-platform-settings.service";

/**
 * Admin supplier-fulfilment delay queue (architecture doc §15.3
 * "Supplier fulfilment delayed"). Real findings from actual
 * CampaignFulfilment rows:
 *  - PAST_ESTIMATED_READY_DATE: the supplier's own estimatedReadyAt has
 *    passed and prep still isn't ready — a real business date, not an
 *    invented deadline.
 *  - STALE_NO_PROGRESS: only checked when the FULFILMENT_STALE_THRESHOLD_HOURS
 *    admin operational setting is configured (Settings -> Operational
 *    Thresholds in admin-web) — with no estimatedReadyAt at all, there is
 *    no client-approved "too long with no progress" duration to invent, so
 *    this half of the scan is a genuine no-op until an admin sets one.
 */
const NOT_YET_READY_STATUSES = ["AWAITING_INVENTORY_CONFIRMATION", "INVENTORY_CONFIRMED", "PACKING"] as const;

interface Finding {
  reason: "PAST_ESTIMATED_READY_DATE" | "STALE_NO_PROGRESS";
  dedupeKey: string;
  campaignId: string;
  evidence: Record<string, unknown>;
}

export const fulfilmentDelayService = {
  async scan(): Promise<{ found: number; staleCheckConfigured: boolean }> {
    const now = new Date();
    const fulfilmentStaleThresholdHours = await adminPlatformSettingsService.getValue("FULFILMENT_STALE_THRESHOLD_HOURS");
    const active = await prisma.campaignFulfilment.findMany({
      where: { status: { in: [...NOT_YET_READY_STATUSES] } },
      select: { campaignId: true, status: true, estimatedReadyAt: true, updatedAt: true, createdAt: true },
    });

    const findings: Finding[] = [];
    for (const f of active) {
      if (f.estimatedReadyAt && f.estimatedReadyAt < now) {
        findings.push({
          reason: "PAST_ESTIMATED_READY_DATE",
          dedupeKey: `PAST_ESTIMATED_READY_DATE:${f.campaignId}`,
          campaignId: f.campaignId,
          evidence: { status: f.status, estimatedReadyAt: f.estimatedReadyAt.toISOString(), hoursOverdue: Math.round((now.getTime() - f.estimatedReadyAt.getTime()) / (60 * 60 * 1000)) },
        });
      } else if (!f.estimatedReadyAt && fulfilmentStaleThresholdHours != null) {
        const staleSince = new Date(now.getTime() - fulfilmentStaleThresholdHours * 60 * 60 * 1000);
        if (f.updatedAt < staleSince) {
          findings.push({
            reason: "STALE_NO_PROGRESS",
            dedupeKey: `STALE_NO_PROGRESS:${f.campaignId}`,
            campaignId: f.campaignId,
            evidence: { status: f.status, lastUpdatedAt: f.updatedAt.toISOString(), staleThresholdHours: fulfilmentStaleThresholdHours },
          });
        }
      }
    }

    for (const finding of findings) {
      await prisma.supplierFulfilmentAlert.upsert({
        where: { dedupeKey: finding.dedupeKey },
        update: { evidence: finding.evidence as Prisma.InputJsonValue, lastSeenAt: new Date() },
        create: {
          reason: finding.reason,
          dedupeKey: finding.dedupeKey,
          campaignId: finding.campaignId,
          evidence: finding.evidence as Prisma.InputJsonValue,
        },
      });
    }

    return { found: findings.length, staleCheckConfigured: fulfilmentStaleThresholdHours != null };
  },

  async list(status?: string) {
    return prisma.supplierFulfilmentAlert.findMany({
      where: status ? { status: status as never } : undefined,
      include: {
        campaign: {
          select: {
            id: true,
            title: true,
            supplier: { select: { vendor: { select: { userId: true, storeName: true } } } },
            supplierAccount: { select: { userId: true, user: { select: { name: true } } } },
          },
        },
      },
      orderBy: { lastSeenAt: "desc" },
      take: 200,
    });
  },

  async addNote(id: string, note: string) {
    const existing = await prisma.supplierFulfilmentAlert.findUnique({ where: { id } });
    if (!existing) throw new AppError("Fulfilment alert not found", 404);
    return prisma.supplierFulfilmentAlert.update({ where: { id }, data: { note } });
  },

  /** Sends a real notification to the supplier's own vendor user, then marks the alert CONTACTED. */
  async contactSupplier(id: string, adminId: string, note: string) {
    const alert = await prisma.supplierFulfilmentAlert.findUnique({
      where: { id },
      include: {
        campaign: {
          select: {
            title: true,
            supplier: { select: { vendor: { select: { userId: true } } } },
            supplierAccount: { select: { userId: true } },
          },
        },
      },
    });
    if (!alert) throw new AppError("Fulfilment alert not found", 404);

    await notificationsService.enqueue({
      // Non-null: a SupplierFulfilmentAlert is only ever raised against a
      // CampaignFulfilment row, which createSupplierOrder() only creates
      // for SUPPLIER-fulfilment campaigns — so either the legacy supplier or
      // (Workstream 3) the SupplierAccount is guaranteed set, never neither.
      userId: alert.campaign.supplierAccount?.userId ?? alert.campaign.supplier!.vendor.userId,
      type: "COMMUNITY_CAMPAIGN_UPDATE",
      title: "Fulfilment follow-up",
      body: `Eki is following up on fulfilment for "${alert.campaign.title}": ${note}`,
      data: { type: "community_campaign_update", event: "fulfilment_follow_up", campaignId: alert.campaignId },
    });

    return prisma.supplierFulfilmentAlert.update({
      where: { id },
      data: { status: "CONTACTED", contactedAt: new Date(), resolvedById: adminId, note },
    });
  },

  async resolve(id: string, adminId: string, note: string) {
    const existing = await prisma.supplierFulfilmentAlert.findUnique({ where: { id } });
    if (!existing) throw new AppError("Fulfilment alert not found", 404);
    return prisma.supplierFulfilmentAlert.update({
      where: { id },
      data: { status: "RESOLVED", resolvedById: adminId, resolvedAt: new Date(), note },
    });
  },

  /** Escalation is a status flag only — it never auto-cancels or auto-refunds; any such action still requires the existing explicit business rules/flows. */
  async escalate(id: string, adminId: string, note: string) {
    const existing = await prisma.supplierFulfilmentAlert.findUnique({ where: { id } });
    if (!existing) throw new AppError("Fulfilment alert not found", 404);
    return prisma.supplierFulfilmentAlert.update({
      where: { id },
      data: { status: "ESCALATED", resolvedById: adminId, resolvedAt: new Date(), note },
    });
  },
};
