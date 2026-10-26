import type { PaymentAnomaly, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { notificationsService } from "../notifications/notifications.service";

type Tx = Prisma.TransactionClient;

export function criticalIncidentAlertsEnabled(): boolean {
  return process.env.R40_PAYMENT_ANOMALY_ALERTS_ENABLED === "true";
}

/** Persist durable, idempotent admin push candidates for confirmed critical incidents. */
export async function ensureCriticalIncidentCandidates(tx: Tx, incident: Pick<PaymentAnomaly, "id" | "dedupeKey" | "kind" | "severity" | "status" | "businessRefType" | "businessRefId">): Promise<void> {
  if (!criticalIncidentAlertsEnabled() || incident.severity !== "CRITICAL" || incident.status !== "OPEN") return;
  const admins = await tx.user.findMany({ where: { role: "ADMIN", isSuspended: false }, select: { id: true } });
  for (const admin of admins) {
    const dedupeKey = `R40_CRITICAL_INCIDENT:${admin.id}:${incident.dedupeKey}`;
    const created = await notificationsService.create({
      userId: admin.id,
      type: "ADMIN_BROADCAST",
      title: "A critical Eki process needs attention",
      body: "Open the incident and review the failed job.",
      data: {
        type: "critical_incident", event: "critical_incident", ruleKey: "R40_CRITICAL_INCIDENT",
        ruleVersion: 1, templateVersion: 1, destination: "admin_case", incidentId: incident.id,
        anomalyKey: incident.dedupeKey, severity: incident.severity, incidentKind: incident.kind,
        businessRefType: incident.businessRefType, businessRefId: incident.businessRefId,
      },
      dedupeKey,
    }, tx);
    const candidate = created ?? await tx.notification.findUnique({ where: { dedupeKey }, select: { id: true } });
    if (candidate) await tx.notificationDelivery.upsert({
      where: { notificationId_channel: { notificationId: candidate.id, channel: "push" } },
      create: { notificationId: candidate.id, channel: "push" }, update: {},
    });
  }
}

/** Replays notification materialization from persisted OPEN incidents after approval/gate activation. */
export async function materializeOpenCriticalIncidents(limit = 100): Promise<void> {
  if (!criticalIncidentAlertsEnabled()) return;
  const incidents = await prisma.paymentAnomaly.findMany({
    where: { severity: "CRITICAL", status: "OPEN" },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(limit, 1), 500),
  });
  for (const incident of incidents) {
    await prisma.$transaction((tx) => ensureCriticalIncidentCandidates(tx, incident));
  }
}
