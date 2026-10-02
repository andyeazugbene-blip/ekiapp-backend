import { AppError } from "../../shared/errors/app-error";

/**
 * Handbook 5 / 5.1 / 14.3 / 14.7: Stripe is the authority for vendor identity
 * verification and for charge/payout capability. Eki only PRESENTS provider
 * state; it must never imitate provider approval. This module is the single
 * place that turns the provider-owned Vendor columns into the admin-facing
 * presentation, and decides whether a manual verification override may exist.
 *
 * "Verified" (identity) never implies charges or payouts: they are returned
 * as separate fields and the combined `stage` is VERIFIED only when identity
 * is verified AND both capabilities are enabled.
 */

export interface VendorProviderFields {
  verificationStatus: "PENDING" | "VERIFIED" | "REJECTED";
  verificationFailureReason: string | null;
  stripeVerificationSessionId: string | null;
  stripeIdentityStatus: string | null;
  stripeIdentityUpdatedAt: Date | null;
  verifiedAt: Date | null;
  stripeAccountId: string | null;
  stripeAccountStatus: string | null;
  stripeChargesEnabled: boolean;
  stripePayoutsEnabled: boolean;
  stripeOnboardedAt: Date | null;
  stripeRequirementsCurrentlyDue: string[];
  stripeRequirementsPastDue: string[];
  stripeRequirementsEventuallyDue: string[];
  stripeDisabledReason: string | null;
  stripeRequirementsDeadline: Date | null;
  stripeStatusFetchedAt: Date | null;
}

/** Prisma `select` covering every field the derivation needs. */
export const VENDOR_PROVIDER_SELECT = {
  verificationStatus: true,
  verificationFailureReason: true,
  stripeVerificationSessionId: true,
  stripeIdentityStatus: true,
  stripeIdentityUpdatedAt: true,
  verifiedAt: true,
  stripeAccountId: true,
  stripeAccountStatus: true,
  stripeChargesEnabled: true,
  stripePayoutsEnabled: true,
  stripeOnboardedAt: true,
  stripeRequirementsCurrentlyDue: true,
  stripeRequirementsPastDue: true,
  stripeRequirementsEventuallyDue: true,
  stripeDisabledReason: true,
  stripeRequirementsDeadline: true,
  stripeStatusFetchedAt: true,
} as const;

export type IdentityState =
  | "NOT_STARTED"
  | "PROCESSING"
  | "PENDING"
  | "NEEDS_INPUT"
  | "VERIFIED"
  | "FAILED"
  | "CANCELED"
  | "REDACTED"
  | "LEGACY_MANUAL";

export type ProviderStage = "NOT_STARTED" | "PENDING" | "REQUIREMENTS_DUE" | "RESTRICTED" | "VERIFIED";
export type PendingOn = "PROVIDER" | "VENDOR" | null;
export type ManagedBy = "STRIPE" | "LEGACY_MANUAL" | "NONE";

export interface VendorProviderReadiness {
  managedBy: ManagedBy;
  stage: ProviderStage;
  pendingOn: PendingOn;
  /** Short human sentence explaining the stage and who must act. */
  summary: string;
  identity: {
    state: IdentityState;
    /** Raw last Stripe VerificationSession status, or null if none recorded. */
    providerStatus: string | null;
    sessionId: string | null;
    verifiedAt: Date | null;
    failureReason: string | null;
    updatedAt: Date | null;
  };
  connect: {
    accountId: string | null;
    status: string | null;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    requirementsCurrentlyDue: string[];
    requirementsPastDue: string[];
    requirementsEventuallyDue: string[];
    requirementsCategories: string[];
    disabledReason: string | null;
    requirementsDeadline: Date | null;
    onboardedAt: Date | null;
    fetchedAt: Date | null;
  };
}

/** Collapses Stripe's dotted requirement keys into admin-friendly categories
 * without ever exposing a value ("individual.dob.day" -> "Personal details"). */
export function requirementCategory(key: string): string {
  const k = key.toLowerCase();
  if (k.startsWith("external_account") || k.includes("bank_account")) return "Bank account";
  if (k.includes("verification.document") || k.includes("verification.additional_document") || k.includes("id_number") || k.includes("ssn")) return "Identity document";
  if (k.startsWith("individual") || k.startsWith("person_") || k.startsWith("relationship") || k.includes("representative")) return "Personal details";
  if (k.startsWith("company") || k.startsWith("business_profile") || k.startsWith("business_type")) return "Business details";
  if (k.startsWith("tos_acceptance")) return "Terms of service";
  return "Other information";
}

const RESTRICTING_DISABLED_PREFIXES = ["rejected", "listed", "platform_paused", "other"];
const PROVIDER_REVIEW_REASONS = ["requirements.pending_verification", "under_review"];

function isRestrictingReason(reason: string | null): boolean {
  if (!reason) return false;
  if (reason === "requirements.past_due") return true;
  return RESTRICTING_DISABLED_PREFIXES.some((p) => reason === p || reason.startsWith(`${p}.`));
}

export function deriveIdentityState(v: Pick<VendorProviderFields,
  "verificationStatus" | "stripeVerificationSessionId" | "stripeIdentityStatus">, hasLegacyDocuments = false): IdentityState {
  if (!v.stripeVerificationSessionId) {
    return hasLegacyDocuments ? "LEGACY_MANUAL" : "NOT_STARTED";
  }
  switch (v.stripeIdentityStatus) {
    case "verified": return "VERIFIED";
    case "processing": return "PROCESSING";
    case "requires_input": return "NEEDS_INPUT";
    case "canceled": return "CANCELED";
    case "redacted": return "REDACTED";
    default: break;
  }
  // Pre-existing rows (before stripeIdentityStatus existed) carry only the
  // coarse Eki status. Old webhook code mapped requires_input to REJECTED, so
  // a REJECTED row with a Stripe session is reported as FAILED/needs retry.
  if (v.verificationStatus === "VERIFIED") return "VERIFIED";
  if (v.verificationStatus === "REJECTED") return "FAILED";
  return "PENDING";
}

export function deriveVendorProviderReadiness(
  v: VendorProviderFields,
  opts: { hasLegacyDocuments?: boolean } = {},
): VendorProviderReadiness {
  const identityState = deriveIdentityState(v, opts.hasLegacyDocuments);
  const providerControlled = isProviderControlledVendor(v);
  const currentlyDue = v.stripeRequirementsCurrentlyDue ?? [];
  const pastDue = v.stripeRequirementsPastDue ?? [];
  const eventuallyDue = v.stripeRequirementsEventuallyDue ?? [];
  const categories = Array.from(new Set([...pastDue, ...currentlyDue].map(requirementCategory)));
  const hasAccount = Boolean(v.stripeAccountId);

  const wasOnboarded = Boolean(v.stripeOnboardedAt);
  const capabilityLost = hasAccount && wasOnboarded && (!v.stripeChargesEnabled || !v.stripePayoutsEnabled);
  const restricted = hasAccount && (isRestrictingReason(v.stripeDisabledReason) || capabilityLost || v.stripeAccountStatus === "deauthorized");
  const requirementsDue = hasAccount && (currentlyDue.length > 0 || pastDue.length > 0);
  const inProviderReview = hasAccount && (
    (v.stripeDisabledReason != null && PROVIDER_REVIEW_REASONS.includes(v.stripeDisabledReason)) ||
    v.stripeAccountStatus === "pending_verification"
  );

  let stage: ProviderStage;
  let pendingOn: PendingOn = null;
  let summary: string;

  if (v.stripeAccountStatus === "deauthorized") {
    stage = "RESTRICTED";
    summary = "The vendor disconnected their Stripe account from Eki. Charges and payouts are off until they reconnect.";
  } else if (restricted) {
    stage = "RESTRICTED";
    summary = `Stripe has restricted this account${v.stripeDisabledReason ? ` (${v.stripeDisabledReason})` : ""}. Contact the vendor or escalate.`;
  } else if (identityState === "NEEDS_INPUT" || identityState === "FAILED" || requirementsDue) {
    stage = "REQUIREMENTS_DUE";
    pendingOn = "VENDOR";
    summary = identityState === "NEEDS_INPUT" || identityState === "FAILED"
      ? "Stripe Identity needs the vendor to retry or provide more input."
      : "Stripe needs more information from the vendor before payments or payouts are fully enabled.";
  } else if (!providerControlled && identityState === "NOT_STARTED") {
    stage = "NOT_STARTED";
    summary = "The vendor has not started Stripe identity verification or payout onboarding.";
  } else if (identityState === "LEGACY_MANUAL") {
    stage = v.verificationStatus === "VERIFIED" ? "VERIFIED" : "PENDING";
    pendingOn = null;
    summary = "Legacy document verification (pre-Stripe). Not managed by Stripe Identity.";
  } else if (identityState === "VERIFIED" && v.stripeChargesEnabled && v.stripePayoutsEnabled) {
    stage = "VERIFIED";
    summary = "Identity verified and Stripe reports charges and payouts enabled.";
  } else {
    stage = "PENDING";
    if (identityState === "PROCESSING" || inProviderReview) {
      pendingOn = "PROVIDER";
      summary = "Waiting for Stripe to finish its review.";
    } else if (identityState === "VERIFIED" && !hasAccount) {
      pendingOn = "VENDOR";
      summary = "Identity verified. The vendor has not created their Stripe payout account yet, so charges and payouts are off.";
    } else if (identityState === "VERIFIED") {
      pendingOn = hasAccount && v.stripeAccountStatus === "pending_verification" ? "PROVIDER" : "VENDOR";
      summary = "Identity verified, but Stripe has not yet enabled both charges and payouts.";
    } else if (identityState === "CANCELED" || identityState === "REDACTED") {
      pendingOn = "VENDOR";
      summary = identityState === "CANCELED"
        ? "The Stripe Identity session was canceled. The vendor needs to start again."
        : "The Stripe Identity record was redacted. The vendor may need to verify again.";
    } else {
      pendingOn = "VENDOR";
      summary = "Waiting for the vendor to complete Stripe onboarding.";
    }
  }

  return {
    managedBy: v.stripeVerificationSessionId || hasAccount ? "STRIPE" : opts.hasLegacyDocuments ? "LEGACY_MANUAL" : "NONE",
    stage,
    pendingOn,
    summary,
    identity: {
      state: identityState,
      providerStatus: v.stripeIdentityStatus,
      sessionId: v.stripeVerificationSessionId,
      verifiedAt: v.verifiedAt,
      failureReason: v.verificationFailureReason,
      updatedAt: v.stripeIdentityUpdatedAt,
    },
    connect: {
      accountId: v.stripeAccountId,
      status: v.stripeAccountStatus,
      chargesEnabled: v.stripeChargesEnabled,
      payoutsEnabled: v.stripePayoutsEnabled,
      requirementsCurrentlyDue: currentlyDue,
      requirementsPastDue: pastDue,
      requirementsEventuallyDue: eventuallyDue,
      requirementsCategories: categories,
      disabledReason: v.stripeDisabledReason,
      requirementsDeadline: v.stripeRequirementsDeadline,
      onboardedAt: v.stripeOnboardedAt,
      fetchedAt: v.stripeStatusFetchedAt,
    },
  };
}

/** A vendor is provider-controlled once Stripe holds any state for them. */
export function isProviderControlledVendor(v: {
  stripeVerificationSessionId?: string | null;
  stripeAccountId?: string | null;
}): boolean {
  return Boolean(v.stripeVerificationSessionId) || Boolean(v.stripeAccountId);
}

export const STRIPE_MANAGED_MESSAGE =
  "This vendor's verification is managed by Stripe Identity and updates automatically via webhook. Manual approve/reject is not available.";

/**
 * Handbook 14.3: no manual Approve/Reject for provider-controlled verification.
 * Decision on legacy records: manual review stays possible ONLY for a vendor
 * that has no Stripe session, no Stripe Connect account and at least one
 * un-deleted pre-Stripe document - i.e. unambiguously legacy. Everything else
 * is 409, including a vendor who never started (they must go through Stripe).
 */
export function assertManualVerificationAllowed(
  vendor: { stripeVerificationSessionId?: string | null; stripeAccountId?: string | null },
  legacyDocumentCount: number,
): void {
  if (isProviderControlledVendor(vendor)) {
    throw new AppError(STRIPE_MANAGED_MESSAGE, 409, { reason: "STRIPE_MANAGED" }, "STRIPE_MANAGED_VERIFICATION");
  }
  if (legacyDocumentCount <= 0) {
    throw new AppError(
      "This vendor has no legacy verification documents to review. They must complete Stripe Identity verification; it cannot be approved manually.",
      409,
      { reason: "NO_LEGACY_DOCUMENTS" },
      "STRIPE_MANAGED_VERIFICATION",
    );
  }
}
