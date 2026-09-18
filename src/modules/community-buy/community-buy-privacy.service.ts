import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

/**
 * M4 — Delivery + privacy infrastructure (spec §14, §15.7, §15.8, AT-38..44).
 *
 * This module deliberately does NOT integrate any real courier, protected-
 * telephony/proxy-number provider, or address-tokenisation vault — none of
 * those are confirmed (spec §26), and inventing one here would misrepresent
 * unbuilt capability as real. Every field that would eventually hold such
 * an integration's identifiers (DeliveryReference.courierProvider/
 * externalDeliveryToken/labelReference) stays null until a real integration
 * exists. Individual delivery itself is gated behind
 * COMMUNITY_BUY_INDIVIDUAL_DELIVERY_ENABLED, which defaults false and must
 * stay false in production until the external DPIA/courier confirmation
 * named in spec §26 actually happens — this module cannot and does not
 * turn it on.
 */

// Read live (not cached at module load, unlike COMMUNITY_BUY_PAYOUT_CUSTODY_CONFIRMED
// in campaign-payout.service.ts) so tests can toggle it per-case without a
// module-reset dance; behaviour is identical in production either way since
// the env var never changes mid-process there.
export function isIndividualDeliveryEnabled(): boolean {
  return process.env.COMMUNITY_BUY_INDIVIDUAL_DELIVERY_ENABLED === "true";
}

// spec §14.4's revocation table, translated to code. SUSPENDED/CLOSED are
// real SupplierAccountState enum values with correct (denying) behaviour
// here, even though no mutation in this codebase currently transitions an
// account into either state (supplier-account.service.ts's restrict()/
// unrestrict() only ever reach APPROVED/RESTRICTED/UNDER_REVIEW) — that is
// a pre-existing supplier-lifecycle gap outside M4's delivery/privacy
// scope, not one this milestone invents or is required to close.
export function isDataAccessAllowed(supplierState: string, controlScope: string | null | undefined): boolean {
  switch (supplierState) {
    case "APPROVED":
      return true;
    case "PAUSED":
      // spec §14.4: "No new invitations; permitted active fulfilment access continues."
      return true;
    case "RESTRICTED":
      // spec §14.4: "Apply control_scope; revoke buyer data unless
      // fulfilment access explicitly preserved." Default (no scope, or any
      // unrecognised scope) is revoke — the safer default.
      return controlScope === "fulfilment_access_preserved";
    case "SUSPENDED":
    case "CLOSED":
    default:
      return false;
  }
}

/** The only controlScope value this milestone gives any meaning to — anything else is rejected at the controller before it ever reaches here. */
export const FULFILMENT_ACCESS_PRESERVED_SCOPE = "fulfilment_access_preserved";

/**
 * Append-only access/action trail (spec §15.8, AT-43). Mirrors
 * recordAudit()'s own never-throws contract exactly: a logging failure
 * must never break the business flow (manifest view, message send,
 * revocation, disclosure) it is merely recording.
 */
export async function recordDataAccess(entry: {
  campaignId: string;
  contributionId?: string | null;
  participantId?: string | null;
  accessorAccountId?: string | null;
  accessorUserId: string;
  accessorRole: "SUPPLIER" | "ORGANISER" | "ADMIN";
  dataCategory: "DELIVERY_STATUS" | "CONTACT_CHANNEL" | "EMERGENCY_NUMBER" | "MANIFEST" | "ADDRESS_DETAIL";
  action: "VIEWED" | "LABEL_GENERATED" | "MESSAGE_SENT" | "PROXY_CALL_STARTED" | "COURIER_SHARED" | "ACCESS_REVOKED" | "ADMIN_OVERRIDE";
  purposeCode: string;
  accessExpiresAt?: Date | null;
  controlScope?: string | null;
  adminOverrideId?: string | null;
}): Promise<void> {
  try {
    await prisma.communityBuyDataAccessLog.create({
      data: {
        campaignId: entry.campaignId,
        contributionId: entry.contributionId ?? null,
        participantId: entry.participantId ?? null,
        accessorAccountId: entry.accessorAccountId ?? null,
        accessorUserId: entry.accessorUserId,
        accessorRole: entry.accessorRole,
        dataCategory: entry.dataCategory,
        action: entry.action,
        purposeCode: entry.purposeCode,
        accessExpiresAt: entry.accessExpiresAt ?? null,
        controlScope: entry.controlScope ?? null,
        adminOverrideId: entry.adminOverrideId ?? null,
      },
    });
  } catch (error) {
    logger.error("Community Buy data-access log write failed", {
      campaignId: entry.campaignId,
      action: entry.action,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Called once a contribution actually becomes PAID/CAPTURED, in either
 * payment mode (see markChargeSucceeded() in campaign-contributions.service.ts
 * and markCaptured() in campaign-authorisation.service.ts) — never before.
 * This IS the capture-dependency gate for everything downstream (manifest,
 * contact, emergency disclosure): a contribution with no DeliveryReference
 * row has nothing for a supplier to ever see. Idempotent (upsert on the
 * unique contributionId) and never throws — a failure here must not roll
 * back or block the payment confirmation it rides behind.
 */
export async function createDeliveryReferenceForContribution(contributionId: string): Promise<void> {
  try {
    const contribution = await prisma.campaignContribution.findUnique({
      where: { id: contributionId },
      select: { campaignId: true, participantId: true },
    });
    if (!contribution) return;
    const campaign = await prisma.communityCampaign.findUnique({
      where: { id: contribution.campaignId },
      select: { deliveryPreference: true },
    });
    if (!campaign) return;
    const status = campaign.deliveryPreference === "DELIVERY" ? "PENDING" : "NOT_REQUIRED";
    await prisma.deliveryReference.upsert({
      where: { contributionId },
      create: {
        campaignId: contribution.campaignId,
        contributionId,
        participantId: contribution.participantId,
        deliveryMethod: campaign.deliveryPreference,
        status,
      },
      update: {},
    });
  } catch (error) {
    logger.error("Failed to create Community Buy DeliveryReference for a captured contribution", {
      contributionId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

const REVOCABLE_STATUSES = ["NOT_REQUIRED", "PENDING", "LABEL_GENERATED", "HANDED_TO_COURIER", "EXCEPTION"] as const;

/** Bulk-revokes every non-terminal DeliveryReference for one campaign (e.g. supplier replacement) — writes exactly one ACCESS_REVOKED log row for the event, not one per row. */
export async function revokeDeliveryReferencesForCampaign(campaignId: string, reasonCode: string, actorUserId: string): Promise<number> {
  const result = await prisma.deliveryReference.updateMany({
    where: { campaignId, status: { in: [...REVOCABLE_STATUSES] } },
    data: { status: "REVOKED", revokedAt: new Date(), revocationReason: reasonCode },
  });
  await recordDataAccess({
    campaignId,
    accessorUserId: actorUserId,
    accessorRole: "ADMIN",
    dataCategory: "MANIFEST",
    action: "ACCESS_REVOKED",
    purposeCode: reasonCode,
  });
  return result.count;
}

/** Bulk-revokes every non-terminal DeliveryReference across every campaign a SupplierAccount is assigned to (restrict/suspend/close) — one ACCESS_REVOKED log row per affected campaign, so the audit trail stays campaign-scoped like every other access-log entry. */
export async function revokeDeliveryReferencesForSupplierAccount(supplierAccountId: string, reasonCode: string, actorUserId: string): Promise<number> {
  const campaigns = await prisma.communityCampaign.findMany({
    where: { supplierAccountId },
    select: { id: true },
  });
  let total = 0;
  for (const campaign of campaigns) {
    total += await revokeDeliveryReferencesForCampaign(campaign.id, reasonCode, actorUserId);
  }
  return total;
}

/**
 * privacy_expiry job (spec §17.2, daily) — revokes anything past its own
 * expiry: open DeliveryReference rows past expiresAt, and data-access-log
 * grants (emergency disclosures) past accessExpiresAt. This is the ONLY
 * place time-bound expiry is enforced outside a live per-read check.
 */
export async function privacyExpirySweep(): Promise<{ deliveryReferencesRevoked: number; accessGrantsExpired: number }> {
  const now = new Date();

  const expiredReferences = await prisma.deliveryReference.findMany({
    where: { status: { in: [...REVOCABLE_STATUSES] }, expiresAt: { lte: now } },
    select: { id: true, campaignId: true },
  });
  let deliveryReferencesRevoked = 0;
  for (const ref of expiredReferences) {
    const claim = await prisma.deliveryReference.updateMany({
      where: { id: ref.id, status: { in: [...REVOCABLE_STATUSES] } },
      data: { status: "REVOKED", revokedAt: now, revocationReason: "privacy_expiry" },
    });
    if (claim.count !== 1) continue;
    deliveryReferencesRevoked++;
    await recordDataAccess({
      campaignId: ref.campaignId,
      accessorUserId: "system:cron",
      accessorRole: "ADMIN",
      dataCategory: "DELIVERY_STATUS",
      action: "ACCESS_REVOKED",
      purposeCode: "privacy_expiry",
    });
  }

  const expiredGrants = await prisma.communityBuyDataAccessLog.findMany({
    where: { action: "ADMIN_OVERRIDE", accessExpiresAt: { lte: now }, revokedAt: null },
    select: { id: true, campaignId: true },
  });
  let accessGrantsExpired = 0;
  for (const grant of expiredGrants) {
    const claim = await prisma.communityBuyDataAccessLog.updateMany({
      where: { id: grant.id, revokedAt: null },
      data: { revokedAt: now, revocationReason: "privacy_expiry" },
    });
    if (claim.count !== 1) continue;
    accessGrantsExpired++;
  }

  return { deliveryReferencesRevoked, accessGrantsExpired };
}

/** Admin search surface for AT-43 / spec §19 "data-access audit search." Any combination of filters; all optional. */
export async function searchDataAccessLog(filters: {
  campaignId?: string;
  supplierAccountId?: string;
  accessorUserId?: string;
  dataCategory?: string;
  action?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}) {
  return prisma.communityBuyDataAccessLog.findMany({
    where: {
      campaignId: filters.campaignId,
      accessorAccountId: filters.supplierAccountId,
      accessorUserId: filters.accessorUserId,
      dataCategory: filters.dataCategory as never,
      action: filters.action as never,
      accessedAt: filters.from || filters.to ? { gte: filters.from, lte: filters.to } : undefined,
    },
    orderBy: { accessedAt: "desc" },
    take: Math.min(filters.limit ?? 100, 500),
  });
}
