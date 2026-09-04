import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

/**
 * Admin duplicate-payment / financial-inconsistency queue (architecture
 * doc §15.3 "Duplicate-payment risk"). Every finding here is derived from
 * real rows — Checkout/Payment already carry a DB-level unique constraint
 * on stripePaymentIntentId (a duplicate there is structurally impossible),
 * so this focuses on the models that don't: SubscriptionPaymentAttempt,
 * CampaignChargeAttempt, CampaignContribution, PurchasedGiftCard — plus
 * the two checks a unique constraint can never catch: two genuinely
 * separate successful charges for the same renewal/contribution (each
 * with its own, different PaymentIntent), and a succeeded payment with no
 * corresponding ledger entry at all.
 */

// Scan window for the ledger-completeness check only — a performance/scope
// bound on how far back to look for NEW anomalies to act on, not a
// business rule about when a payment is "too old" to matter.
const LEDGER_SCAN_WINDOW_DAYS = 90;

interface Finding {
  kind: "DUPLICATE_PROVIDER_REF" | "MULTIPLE_SUCCESSFUL_ATTEMPTS" | "MISSING_LEDGER_ENTRY";
  dedupeKey: string;
  businessRefType: string;
  businessRefId: string;
  evidence: Record<string, unknown>;
}

async function findDuplicateProviderRefs(): Promise<Finding[]> {
  const findings: Finding[] = [];

  const subscriptionAttemptDupes = await prisma.subscriptionPaymentAttempt.groupBy({ by: ["stripePaymentIntentId"], where: { stripePaymentIntentId: { not: null } }, _count: { _all: true }, orderBy: { stripePaymentIntentId: "asc" } });
  const campaignChargeDupes = await prisma.campaignChargeAttempt.groupBy({ by: ["stripePaymentIntentId"], where: { stripePaymentIntentId: { not: null } }, _count: { _all: true }, orderBy: { stripePaymentIntentId: "asc" } });
  const contributionDupes = await prisma.campaignContribution.groupBy({ by: ["stripePaymentIntentId"], where: { stripePaymentIntentId: { not: null } }, _count: { _all: true }, orderBy: { stripePaymentIntentId: "asc" } });
  const giftCardDupes = await prisma.purchasedGiftCard.groupBy({ by: ["stripePaymentIntentId"], where: { stripePaymentIntentId: { not: null } }, _count: { _all: true }, orderBy: { stripePaymentIntentId: "asc" } });

  const sources: { table: string; rows: { stripePaymentIntentId: string | null; _count: { _all: number } }[] }[] = [
    { table: "SubscriptionPaymentAttempt", rows: subscriptionAttemptDupes },
    { table: "CampaignChargeAttempt", rows: campaignChargeDupes },
    { table: "CampaignContribution", rows: contributionDupes },
    { table: "PurchasedGiftCard", rows: giftCardDupes },
  ];

  for (const source of sources) {
    for (const row of source.rows) {
      if (row._count._all > 1 && row.stripePaymentIntentId) {
        findings.push({
          kind: "DUPLICATE_PROVIDER_REF",
          dedupeKey: `DUPLICATE_PROVIDER_REF:${source.table}:${row.stripePaymentIntentId}`,
          businessRefType: source.table,
          businessRefId: row.stripePaymentIntentId,
          evidence: { table: source.table, stripePaymentIntentId: row.stripePaymentIntentId, count: row._count._all },
        });
      }
    }
  }

  // Cross-table collision: the same PaymentIntent id genuinely should never
  // belong to more than one of these unrelated payment domains at once.
  const byRef = new Map<string, string[]>();
  const allRefRows: { table: string; ref: string | null }[] = [
    ...(await prisma.subscriptionPaymentAttempt.findMany({ where: { stripePaymentIntentId: { not: null } }, select: { stripePaymentIntentId: true } })).map((r) => ({ table: "SubscriptionPaymentAttempt", ref: r.stripePaymentIntentId })),
    ...(await prisma.campaignChargeAttempt.findMany({ where: { stripePaymentIntentId: { not: null } }, select: { stripePaymentIntentId: true } })).map((r) => ({ table: "CampaignChargeAttempt", ref: r.stripePaymentIntentId })),
    ...(await prisma.checkout.findMany({ where: { stripePaymentIntentId: { not: null } }, select: { stripePaymentIntentId: true } })).map((r) => ({ table: "Checkout", ref: r.stripePaymentIntentId })),
    ...(await prisma.payment.findMany({ where: { stripePaymentIntentId: { not: null } }, select: { stripePaymentIntentId: true } })).map((r) => ({ table: "Payment", ref: r.stripePaymentIntentId })),
  ];
  for (const { table, ref } of allRefRows) {
    if (!ref) continue;
    const tables = byRef.get(ref) ?? [];
    if (!tables.includes(table)) tables.push(table);
    byRef.set(ref, tables);
  }
  for (const [ref, tables] of byRef) {
    if (tables.length > 1) {
      findings.push({
        kind: "DUPLICATE_PROVIDER_REF",
        dedupeKey: `DUPLICATE_PROVIDER_REF:cross-table:${ref}`,
        businessRefType: "StripePaymentIntent",
        businessRefId: ref,
        evidence: { stripePaymentIntentId: ref, tables },
      });
    }
  }

  return findings;
}

async function findMultipleSuccessfulAttempts(): Promise<Finding[]> {
  const findings: Finding[] = [];

  const renewalDupes = await prisma.subscriptionPaymentAttempt.groupBy({
    by: ["renewalId"],
    where: { status: "SUCCEEDED" },
    _count: { _all: true },
  });
  for (const row of renewalDupes) {
    if (row._count._all > 1) {
      findings.push({
        kind: "MULTIPLE_SUCCESSFUL_ATTEMPTS",
        dedupeKey: `MULTIPLE_SUCCESSFUL_ATTEMPTS:Renewal:${row.renewalId}`,
        businessRefType: "Renewal",
        businessRefId: row.renewalId,
        evidence: { renewalId: row.renewalId, successfulAttempts: row._count._all },
      });
    }
  }

  const contributionDupes = await prisma.campaignChargeAttempt.groupBy({
    by: ["contributionId"],
    where: { status: "SUCCEEDED" },
    _count: { _all: true },
  });
  for (const row of contributionDupes) {
    if (row._count._all > 1) {
      findings.push({
        kind: "MULTIPLE_SUCCESSFUL_ATTEMPTS",
        dedupeKey: `MULTIPLE_SUCCESSFUL_ATTEMPTS:CampaignContribution:${row.contributionId}`,
        businessRefType: "CampaignContribution",
        businessRefId: row.contributionId,
        evidence: { contributionId: row.contributionId, successfulAttempts: row._count._all },
      });
    }
  }

  return findings;
}

async function findMissingLedgerEntries(): Promise<Finding[]> {
  const since = new Date(Date.now() - LEDGER_SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const succeededPayments = await prisma.payment.findMany({
    where: { status: "SUCCEEDED", vendorEarningsAmount: { gt: 0 }, processedAt: { gte: since } },
    select: { id: true, orderId: true },
  });
  if (succeededPayments.length === 0) return [];

  const paymentIds = succeededPayments.map((p) => p.id);
  const withLedgerEntries = await prisma.ledgerEntry.findMany({
    where: { businessRefType: "Payment", businessRefId: { in: paymentIds } },
    select: { businessRefId: true },
    distinct: ["businessRefId"],
  });
  const hasLedger = new Set(withLedgerEntries.map((e) => e.businessRefId));

  const findings: Finding[] = [];
  for (const payment of succeededPayments) {
    if (!hasLedger.has(payment.id)) {
      findings.push({
        kind: "MISSING_LEDGER_ENTRY",
        dedupeKey: `MISSING_LEDGER_ENTRY:Payment:${payment.id}`,
        businessRefType: "Payment",
        businessRefId: payment.id,
        evidence: { paymentId: payment.id, orderId: payment.orderId },
      });
    }
  }
  return findings;
}

export const paymentAnomalyService = {
  /**
   * Runs every detection rule and upserts each finding, keyed on its
   * stable dedupeKey — a re-scan refreshes `evidence`/`lastSeenAt` on an
   * existing row without resetting a REVIEWED/ESCALATED status back to
   * OPEN, and never invents a finding that isn't backed by real rows.
   */
  async scan(): Promise<{ found: number }> {
    const findings = [
      ...(await findDuplicateProviderRefs()),
      ...(await findMultipleSuccessfulAttempts()),
      ...(await findMissingLedgerEntries()),
    ];

    for (const finding of findings) {
      await prisma.paymentAnomaly.upsert({
        where: { dedupeKey: finding.dedupeKey },
        update: { evidence: finding.evidence as Prisma.InputJsonValue, lastSeenAt: new Date() },
        create: {
          kind: finding.kind,
          dedupeKey: finding.dedupeKey,
          businessRefType: finding.businessRefType,
          businessRefId: finding.businessRefId,
          evidence: finding.evidence as Prisma.InputJsonValue,
        },
      });
    }

    return { found: findings.length };
  },

  async list(status?: string) {
    return prisma.paymentAnomaly.findMany({
      where: status ? { status: status as never } : undefined,
      orderBy: { lastSeenAt: "desc" },
      take: 200,
    });
  },

  async markReviewed(id: string, adminId: string, note: string) {
    const existing = await prisma.paymentAnomaly.findUnique({ where: { id } });
    if (!existing) throw new AppError("Payment anomaly not found", 404);
    return prisma.paymentAnomaly.update({
      where: { id },
      data: { status: "REVIEWED", reviewedById: adminId, reviewedAt: new Date(), note },
    });
  },

  /** Escalation is a status flag only — it never alters financial truth itself; any correction still goes through the existing controlled-action/four-eyes paths (refunds, ledger reversal, etc). */
  async escalate(id: string, adminId: string, note: string) {
    const existing = await prisma.paymentAnomaly.findUnique({ where: { id } });
    if (!existing) throw new AppError("Payment anomaly not found", 404);
    return prisma.paymentAnomaly.update({
      where: { id },
      data: { status: "ESCALATED", reviewedById: adminId, reviewedAt: new Date(), note },
    });
  },
};
