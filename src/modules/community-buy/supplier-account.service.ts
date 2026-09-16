import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { revokeDeliveryReferencesForSupplierAccount } from "./community-buy-privacy.service";
import { alertOps } from "./ops-alert.service";
import { campaignPayoutService } from "./campaign-payout.service";

// AT-30 — "before holds" states: participants have already committed
// (campaign is publicly live or actively progressing toward capture) but
// no capture has completed yet. Deliberately excludes DRAFT/UNDER_REVIEW/
// CHANGES_REQUIRED/APPROVED (never published — organiser can just
// reassign before publishing, no participant is affected yet) and
// anything at/after FULFILLING (that is AT-31's "after capture" territory).
const PRE_CAPTURE_REVIEW_STATUSES = ["LIVE", "PAUSED", "RESCUE_WINDOW", "HOLD_WINDOW", "DECISION_REQUIRED", "AWAITING_SUPPLIER_RECONFIRMATION", "PAYMENT_CAPTURE"] as const;

/**
 * M8/M10 — actionable ops alerts for supplier suspension. Never auto-
 * cancels or auto-reassigns anything — spec explicitly requires a human
 * "replacement/cancellation review" (AT-30), not a silent campaign
 * cancellation. Two separate alerts for two separate real scenarios:
 *  - a campaign still progressing toward capture (AT-30 — "before holds")
 *  - a campaign whose fulfilment has already started (M8 — "active
 *    fulfilment" observability requirement; also underlies AT-31, where
 *    data access is additionally revoked and payout held elsewhere).
 */
async function alertSupplierSuspensionReviewNeeded(supplierAccountId: string, reason: string): Promise<void> {
  try {
    const [preCaptureCampaigns, activeFulfilmentCampaigns] = await Promise.all([
      prisma.communityCampaign.findMany({
        where: { supplierAccountId, status: { in: [...PRE_CAPTURE_REVIEW_STATUSES] } },
        select: { id: true, title: true, status: true },
      }),
      prisma.communityCampaign.findMany({
        where: { supplierAccountId, fulfilment: { status: { not: "COMPLETED" } } },
        select: { id: true, title: true, fulfilment: { select: { status: true } } },
      }),
    ]);

    if (preCaptureCampaigns.length > 0) {
      await alertOps(
        `🚨 Supplier suspended with ${preCaptureCampaigns.length} campaign(s) still before capture — replacement/cancellation review needed`,
        `<h2>Supplier Suspended — Replacement/Cancellation Review Needed</h2><p>Supplier account: ${supplierAccountId}</p><p>Reason: ${reason}</p><ul>${preCaptureCampaigns.map((c) => `<li>${c.title} (${c.id}) — status: ${c.status}</li>`).join("")}</ul><p>No campaign was cancelled automatically — an admin must decide replacement vs. cancellation for each.</p>`,
      );
    }
    if (activeFulfilmentCampaigns.length > 0) {
      await alertOps(
        `⚠️ Supplier suspended with ${activeFulfilmentCampaigns.length} active fulfilment(s) in progress`,
        `<h2>Supplier Suspended — Active Fulfilment In Progress</h2><p>Supplier account: ${supplierAccountId}</p><p>Reason: ${reason}</p><ul>${activeFulfilmentCampaigns.map((c) => `<li>${c.title} (${c.id}) — fulfilment status: ${c.fulfilment?.status ?? "unknown"}</li>`).join("")}</ul><p>Data access for these campaigns has already been revoked (spec §14.4: permitted active fulfilment access continues) — this alert is for operational follow-up on the physical fulfilment itself.</p>`,
      );
      // AT-31 — "holds payout while fulfilment/refund is resolved." Payout
      // eligibility (campaign-payout.service.ts's assessPayoutEligibility())
      // already re-checks supplierState on every markReady()/
      // triggerManualPayout() call and would refuse regardless, but a
      // payout already sitting READY should be VISIBLY held, not silently
      // blocked only at the last step — never-throws, safe no-op if no
      // payout row exists yet for a given campaign.
      for (const c of activeFulfilmentCampaigns) {
        await campaignPayoutService.holdForSystemReason(c.id, "supplier_suspended");
      }
    }
  } catch (error) {
    logger.error("Supplier-suspension review alert failed (non-blocking)", { supplierAccountId, errorMessage: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Community Buy Workstream 1 — SupplierAccount is user-keyed and requires
 * no Vendor/VendorProfile at all, unlike the legacy vendor-dependent
 * SupplierProfile (organiser-supplier.service.ts). This is the deliberate
 * fix for the anti-pattern the whole mandate targets: Supplier Centre must
 * never force retail-vendor onboarding as a prerequisite.
 *
 * The legacy service/model are untouched by this file — existing verified
 * suppliers keep working exactly as before, mirrored into this table by
 * syncSupplierAccountForProfile() below (called from
 * organiser-supplier.service.ts's own mutation points), not replaced.
 */

const REQUIRED_FIELDS = ["categories", "coverageRegions"] as const;

function computeRequirementsDue(account: { categories: string[]; coverageRegions: string[] }): string[] {
  const due: string[] = [];
  if (account.categories.length === 0) due.push("categories");
  if (account.coverageRegions.length === 0) due.push("coverageRegions");
  return due;
}

export const supplierAccountService = {
  /**
   * Read-only view for the Supplier Centre landing screen. Never creates a
   * row — a user who has merely looked at Supplier Centre should not
   * accumulate a database row, mirroring how SupplierProfile itself is
   * only ever created by an actual application.
   */
  async getView(userId: string) {
    const account = await prisma.supplierAccount.findUnique({ where: { userId } });
    if (!account) {
      return { supplierState: "NOT_STARTED" as const, requirementsDue: [...REQUIRED_FIELDS] };
    }
    return account;
  },

  /**
   * Start (or view the result of) Supplier Centre onboarding. Deliberately
   * has NO Vendor lookup, NO verification requirement, NO market-assignment
   * check — those were the legacy prerequisite this change removes. Real
   * Stripe Connect / KYC onboarding is Workstream 3; this records intent
   * and minimal profile data only.
   */
  async applyAsSupplier(userId: string, input: { country: string; categories?: string[]; coverageRegions?: string[]; collectionCapacityPerDay?: number }) {
    const existing = await prisma.supplierAccount.findUnique({ where: { userId } });
    if (existing && (existing.supplierState === "APPROVED" || existing.supplierState === "RESTRICTED")) {
      // Already decided — applying again is a no-op, not a re-application.
      return existing;
    }
    if (existing?.supplierState === "SUSPENDED" || existing?.supplierState === "CLOSED") {
      // M5 — unlike RESTRICTED (a no-op re-apply above) or INFORMATION_REQUIRED
      // (falls through below, a legitimate resubmission), SUSPENDED/CLOSED are
      // admin-only outcomes with no self-service reversal — re-applying must
      // not quietly resurrect the account into UNDER_REVIEW.
      throw new AppError("This supplier account cannot be re-applied for — contact support.", 403);
    }

    const categories = input.categories ?? existing?.categories ?? [];
    const coverageRegions = input.coverageRegions ?? existing?.coverageRegions ?? [input.country];
    const collectionCapacityPerDay = input.collectionCapacityPerDay ?? existing?.collectionCapacityPerDay ?? null;

    const account = await prisma.supplierAccount.upsert({
      where: { userId },
      create: {
        userId,
        supplierState: "UNDER_REVIEW",
        categories,
        coverageRegions,
        collectionCapacityPerDay,
      },
      update: {
        supplierState: "UNDER_REVIEW",
        categories,
        coverageRegions,
        collectionCapacityPerDay,
      },
    });

    return { ...account, requirementsDue: computeRequirementsDue(account) };
  },

  /**
   * Workstream 3 — backs the admin-web SupplierAccount review screen
   * (Set B, previously backend-only per Workstream 1's own comment on the
   * approve/restrict/unrestrict routes). Optional state filter so admin can
   * default to the review queue (UNDER_REVIEW/INFORMATION_REQUIRED) without
   * a separate endpoint.
   */
  async listForAdmin(state?: string) {
    return prisma.supplierAccount.findMany({
      where: state ? { supplierState: state as never } : undefined,
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });
  },

  async approve(id: string) {
    return prisma.supplierAccount.update({
      where: { id },
      data: { supplierState: "APPROVED", approvedAt: new Date(), reasonCode: null },
    });
  },

  /**
   * M4 (spec §14.4, §15.4) — controlScope finally gets written, not just
   * stored. `"fulfilment_access_preserved"` is the only recognised value
   * (validated by the controller before this is called); anything else
   * (including omitted) means the default, safer behaviour: restriction
   * revokes participant-delivery-data access — see
   * community-buy-privacy.service.ts's isDataAccessAllowed().
   */
  async restrict(id: string, reason: string, controlScope: string | null = null) {
    return prisma.supplierAccount.update({
      where: { id },
      data: { supplierState: "RESTRICTED", reasonCode: reason, controlScope },
    });
  },

  /**
   * M5 fix: before SUSPENDED was reachable (pre-M5, the state was dead —
   * see this file's own historical comment on syncSupplierAccountForProfile),
   * this function's lack of a state guard was harmless — nothing could ever
   * BE suspended, so nothing could be accidentally un-suspended through it.
   * Now that suspend() is real and 2FA-gated, this function must refuse a
   * SUSPENDED (or CLOSED) account explicitly rather than silently restoring
   * it — reversing a suspension needs its own equally-guarded path
   * (unsuspend() below), never the lighter-weight restriction-lifting flow.
   */
  async unrestrict(id: string) {
    const account = await prisma.supplierAccount.findUnique({ where: { id } });
    if (!account) throw new AppError("Supplier account not found", 404);
    if (account.supplierState === "SUSPENDED") throw new AppError("This account is suspended — use unsuspend, not unrestrict", 409);
    if (account.supplierState === "CLOSED") throw new AppError("This supplier account is permanently closed", 409);
    // Restriction is independent of approval (mirrors organiser-supplier.service.ts's
    // existing isRestricted/isVerified separation) — unrestricting returns to
    // APPROVED if this account was previously approved (has approvedAt),
    // otherwise back to UNDER_REVIEW. controlScope is cleared — it only
    // ever means something while RESTRICTED.
    return prisma.supplierAccount.update({
      where: { id },
      data: { supplierState: account.approvedAt ? "APPROVED" : "UNDER_REVIEW", reasonCode: null, controlScope: null },
    });
  },

  /** M5 — the equally-guarded reversal for suspend(); admin-only, same 2FA weight as suspend() itself (enforced at the route layer). Does not restore data access retroactively — a fresh manifest/emergency-contact call will simply see the now-current, allowed state; nothing needs to be "re-granted." */
  async unsuspend(id: string) {
    const account = await prisma.supplierAccount.findUnique({ where: { id } });
    if (!account) throw new AppError("Supplier account not found", 404);
    if (account.supplierState !== "SUSPENDED") throw new AppError("This account is not suspended", 409);
    return prisma.supplierAccount.update({
      where: { id },
      data: { supplierState: account.approvedAt ? "APPROVED" : "UNDER_REVIEW", reasonCode: null, suspendedAt: null },
    });
  },

  /** M5 (spec §10.1/§10.2 step 6 "request information") — admin sends a specific correction request. The existing applyAsSupplier() re-application path (a plain upsert back to UNDER_REVIEW) is reused for resubmission — no separate "resubmit" endpoint invented. */
  async requestInformation(id: string, reason: string) {
    const account = await prisma.supplierAccount.findUnique({ where: { id } });
    if (!account) throw new AppError("Supplier account not found", 404);
    if (account.supplierState === "CLOSED") throw new AppError("This supplier account is permanently closed", 409);
    return prisma.supplierAccount.update({
      where: { id },
      data: { supplierState: "INFORMATION_REQUIRED", reasonCode: reason },
    });
  },

  /**
   * M5 (spec §6.4 "suspended: Capability disabled pending resolution";
   * §14.4 "suspended: Atomically revoke participant data, messaging,
   * labels/exports and sessions") — admin-only, reachable from any
   * non-terminal state. Always revokes data access regardless of any
   * controlScope on file (isDataAccessAllowed() already denies SUSPENDED
   * unconditionally; this call is what makes that denial show up as a
   * concrete, audited DeliveryReference revocation too, same as restrict()
   * without a preserved scope).
   */
  async suspend(id: string, reason: string, actorId: string) {
    const account = await prisma.supplierAccount.findUnique({ where: { id } });
    if (!account) throw new AppError("Supplier account not found", 404);
    if (account.supplierState === "CLOSED") throw new AppError("This supplier account is permanently closed", 409);
    const updated = await prisma.supplierAccount.update({
      where: { id },
      data: { supplierState: "SUSPENDED", reasonCode: reason, suspendedAt: new Date() },
    });
    await revokeDeliveryReferencesForSupplierAccount(id, "supplier_suspended", actorId);
    await alertSupplierSuspensionReviewNeeded(id, reason);
    return updated;
  },

  /** M5 — permanent, terminal (spec §6.4 "closed: Permanently closed"). No un-close exists, matching "closed" being the terminal state in the spec's own state table. */
  async close(id: string, reason: string, actorId: string) {
    const account = await prisma.supplierAccount.findUnique({ where: { id } });
    if (!account) throw new AppError("Supplier account not found", 404);
    if (account.supplierState === "CLOSED") return account; // idempotent
    const updated = await prisma.supplierAccount.update({
      where: { id },
      data: { supplierState: "CLOSED", reasonCode: reason, closedAt: new Date() },
    });
    await revokeDeliveryReferencesForSupplierAccount(id, "supplier_closed", actorId);
    return updated;
  },

  /**
   * M5 (spec §6.4 "paused: Voluntarily unavailable for new work") — the
   * ONLY self-service (supplier-initiated, not admin) state transition.
   * Only reachable from APPROVED, matching "existing obligations plus
   * unavailable status" (§10.1) — pausing is a temporary step-back for an
   * already-approved supplier, not a way to skip review.
   */
  async pause(userId: string) {
    const account = await prisma.supplierAccount.findUnique({ where: { userId } });
    if (!account) throw new AppError("Supplier account required", 403);
    if (account.supplierState !== "APPROVED") throw new AppError("Only an approved supplier account can be paused", 409);
    return prisma.supplierAccount.update({
      where: { id: account.id },
      data: { supplierState: "PAUSED", pausedAt: new Date() },
    });
  },

  async resume(userId: string) {
    const account = await prisma.supplierAccount.findUnique({ where: { userId } });
    if (!account) throw new AppError("Supplier account required", 403);
    if (account.supplierState !== "PAUSED") throw new AppError("This supplier account is not paused", 409);
    return prisma.supplierAccount.update({
      where: { id: account.id },
      data: { supplierState: "APPROVED", pausedAt: null },
    });
  },

  /**
   * M5 — called from supplier-stripe-connect.service.ts's getStatus() live
   * poll. Distinct from requirementsDue (Eki-side profile completeness,
   * computeRequirementsDue() above) — this is Stripe's own
   * requirements.currently_due. Only demotes UNDER_REVIEW → VERIFICATION_REQUIRED
   * (Eki review cannot meaningfully proceed while Stripe itself still needs
   * something) and promotes back once clear — never touches APPROVED,
   * RESTRICTED, PAUSED, SUSPENDED or CLOSED, so an already-decided account
   * is never silently reopened by a Stripe-side compliance re-check.
   */
  async syncStripeRequirements(accountId: string, stripeRequirementsDue: string[]) {
    const account = await prisma.supplierAccount.findUnique({ where: { id: accountId } });
    if (!account) return;
    const data: { stripeRequirementsDue: string[]; supplierState?: "VERIFICATION_REQUIRED" | "UNDER_REVIEW" } = { stripeRequirementsDue };
    if (account.supplierState === "UNDER_REVIEW" && stripeRequirementsDue.length > 0) {
      data.supplierState = "VERIFICATION_REQUIRED";
    } else if (account.supplierState === "VERIFICATION_REQUIRED" && stripeRequirementsDue.length === 0) {
      data.supplierState = "UNDER_REVIEW";
    }
    await prisma.supplierAccount.update({ where: { id: accountId }, data });
  },

  /**
   * Idempotent legacy-sync — both the one-time backfill's loop body and
   * the live-sync hook called from organiser-supplier.service.ts after
   * every mutation to a Vendor-backed SupplierProfile. Classification uses
   * only columns that exist and are provably authoritative; never
   * fabricates DRAFT/VERIFICATION_REQUIRED/INFORMATION_REQUIRED/PAUSED/
   * SUSPENDED/CLOSED from the legacy isVerified/isRestricted booleans.
   */
  async syncSupplierAccountForProfile(supplierProfileId: string): Promise<{
    profileId: string;
    vendorId: string;
    userId: string;
    state: "APPROVED" | "RESTRICTED" | "UNDER_REVIEW";
    reason: string;
  } | null> {
    const profile = await prisma.supplierProfile.findUnique({
      where: { id: supplierProfileId },
      select: {
        id: true,
        vendorId: true,
        isVerified: true,
        isRestricted: true,
        restrictedReason: true,
        verifiedAt: true,
        country: true,
        vendor: {
          select: {
            userId: true,
            stripeAccountId: true,
            stripeChargesEnabled: true,
            stripePayoutsEnabled: true,
          },
        },
      },
    });
    if (!profile) return null;

    let state: "APPROVED" | "RESTRICTED" | "UNDER_REVIEW";
    let reason: string;
    if (profile.isRestricted) {
      state = "RESTRICTED";
      reason = `isRestricted=true (independent of isVerified=${profile.isVerified}) — restriction flag is authoritative.`;
    } else if (profile.isVerified) {
      state = "APPROVED";
      reason = profile.verifiedAt
        ? `isVerified=true, isRestricted=false, verifiedAt=${profile.verifiedAt.toISOString()} corroborates.`
        : "isVerified=true, isRestricted=false (verifiedAt missing — anomaly, not blocking).";
    } else {
      state = "UNDER_REVIEW";
      reason = "SupplierProfile exists (application submitted) but isVerified=false, isRestricted=false — awaiting decision.";
    }

    await prisma.supplierAccount.upsert({
      where: { userId: profile.vendor.userId },
      create: {
        userId: profile.vendor.userId,
        legacySupplierProfileId: profile.id,
        supplierState: state,
        providerConnectedAccountId: profile.vendor.stripeAccountId,
        chargesEnabled: profile.vendor.stripeChargesEnabled,
        payoutsEnabled: profile.vendor.stripePayoutsEnabled,
        approvedAt: state === "APPROVED" ? profile.verifiedAt ?? new Date() : null,
        reasonCode: profile.restrictedReason,
        coverageRegions: [profile.country],
      },
      update: {
        legacySupplierProfileId: profile.id,
        supplierState: state,
        providerConnectedAccountId: profile.vendor.stripeAccountId,
        chargesEnabled: profile.vendor.stripeChargesEnabled,
        payoutsEnabled: profile.vendor.stripePayoutsEnabled,
        approvedAt: state === "APPROVED" ? profile.verifiedAt ?? new Date() : null,
        reasonCode: profile.restrictedReason,
      },
    });

    return { profileId: profile.id, vendorId: profile.vendorId, userId: profile.vendor.userId, state, reason };
  },
};
