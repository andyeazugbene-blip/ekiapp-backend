import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

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
  async applyAsSupplier(userId: string, input: { country: string; categories?: string[]; coverageRegions?: string[] }) {
    const existing = await prisma.supplierAccount.findUnique({ where: { userId } });
    if (existing && (existing.supplierState === "APPROVED" || existing.supplierState === "RESTRICTED")) {
      // Already decided — applying again is a no-op, not a re-application.
      return existing;
    }

    const categories = input.categories ?? existing?.categories ?? [];
    const coverageRegions = input.coverageRegions ?? existing?.coverageRegions ?? [input.country];

    const account = await prisma.supplierAccount.upsert({
      where: { userId },
      create: {
        userId,
        supplierState: "UNDER_REVIEW",
        categories,
        coverageRegions,
      },
      update: {
        supplierState: "UNDER_REVIEW",
        categories,
        coverageRegions,
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

  async restrict(id: string, reason: string) {
    return prisma.supplierAccount.update({
      where: { id },
      data: { supplierState: "RESTRICTED", reasonCode: reason },
    });
  },

  async unrestrict(id: string) {
    const account = await prisma.supplierAccount.findUnique({ where: { id } });
    if (!account) throw new AppError("Supplier account not found", 404);
    // Restriction is independent of approval (mirrors organiser-supplier.service.ts's
    // existing isRestricted/isVerified separation) — unrestricting returns to
    // APPROVED if this account was previously approved (has approvedAt),
    // otherwise back to UNDER_REVIEW.
    return prisma.supplierAccount.update({
      where: { id },
      data: { supplierState: account.approvedAt ? "APPROVED" : "UNDER_REVIEW", reasonCode: null },
    });
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
