import { describe, expect, it } from "vitest";
import {
  assertManualVerificationAllowed,
  deriveVendorProviderReadiness,
  requirementCategory,
  type VendorProviderFields,
} from "../modules/vendors/vendor-provider-readiness";

const base: VendorProviderFields = {
  verificationStatus: "PENDING",
  verificationFailureReason: null,
  stripeVerificationSessionId: null,
  stripeIdentityStatus: null,
  stripeIdentityUpdatedAt: null,
  verifiedAt: null,
  stripeAccountId: null,
  stripeAccountStatus: null,
  stripeChargesEnabled: false,
  stripePayoutsEnabled: false,
  stripeOnboardedAt: null,
  stripeRequirementsCurrentlyDue: [],
  stripeRequirementsPastDue: [],
  stripeRequirementsEventuallyDue: [],
  stripeDisabledReason: null,
  stripeRequirementsDeadline: null,
  stripeStatusFetchedAt: null,
};

describe("deriveVendorProviderReadiness", () => {
  it("never reports VERIFIED from identity alone - charges and payouts must both be on", () => {
    const r = deriveVendorProviderReadiness({
      ...base, verificationStatus: "VERIFIED", stripeVerificationSessionId: "vs_1", stripeIdentityStatus: "verified",
      stripeAccountId: "acct_1", stripeChargesEnabled: true, stripePayoutsEnabled: false,
    });
    expect(r.identity.state).toBe("VERIFIED");
    expect(r.stage).toBe("PENDING");
    expect(r.connect.payoutsEnabled).toBe(false);
  });

  it("is VERIFIED only when identity verified AND charges AND payouts enabled", () => {
    const r = deriveVendorProviderReadiness({
      ...base, verificationStatus: "VERIFIED", stripeVerificationSessionId: "vs_1", stripeIdentityStatus: "verified",
      stripeAccountId: "acct_1", stripeChargesEnabled: true, stripePayoutsEnabled: true,
    });
    expect(r.stage).toBe("VERIFIED");
    expect(r.managedBy).toBe("STRIPE");
  });

  it("requires_input is 'needs input' (vendor action), not a final rejection", () => {
    const r = deriveVendorProviderReadiness({
      ...base, verificationStatus: "REJECTED", stripeVerificationSessionId: "vs_1", stripeIdentityStatus: "requires_input",
    });
    expect(r.identity.state).toBe("NEEDS_INPUT");
    expect(r.stage).toBe("REQUIREMENTS_DUE");
    expect(r.pendingOn).toBe("VENDOR");
  });

  it("processing is waiting on the provider", () => {
    const r = deriveVendorProviderReadiness({ ...base, stripeVerificationSessionId: "vs_1", stripeIdentityStatus: "processing" });
    expect(r.pendingOn).toBe("PROVIDER");
  });

  it("flags a previously-onboarded account that lost capability as RESTRICTED", () => {
    const r = deriveVendorProviderReadiness({
      ...base, stripeAccountId: "acct_1", stripeOnboardedAt: new Date(), stripeChargesEnabled: false, stripePayoutsEnabled: false,
      stripeDisabledReason: "rejected.fraud",
    });
    expect(r.stage).toBe("RESTRICTED");
  });

  it("requirements due surface with categories and never expose raw values", () => {
    const r = deriveVendorProviderReadiness({
      ...base, stripeAccountId: "acct_1", stripeRequirementsCurrentlyDue: ["individual.dob.day", "external_account"],
    });
    expect(r.stage).toBe("REQUIREMENTS_DUE");
    expect(r.connect.requirementsCategories).toEqual(expect.arrayContaining(["Personal details", "Bank account"]));
  });

  it("lost payouts WITH requirements due is requirements-due (fixable), not restricted", () => {
    const r = deriveVendorProviderReadiness({
      ...base, stripeAccountId: "acct_1", stripeOnboardedAt: new Date(), stripeChargesEnabled: true, stripePayoutsEnabled: false,
      stripeRequirementsCurrentlyDue: ["external_account"],
    });
    expect(r.stage).toBe("REQUIREMENTS_DUE");
  });

  it("deauthorized accounts are restricted", () => {
    const r = deriveVendorProviderReadiness({ ...base, stripeAccountId: "acct_1", stripeAccountStatus: "deauthorized" });
    expect(r.stage).toBe("RESTRICTED");
  });
});

describe("assertManualVerificationAllowed", () => {
  it("blocks Stripe-managed vendors", () => {
    expect(() => assertManualVerificationAllowed({ stripeVerificationSessionId: "vs_1" }, 3)).toThrow(/Stripe/);
    expect(() => assertManualVerificationAllowed({ stripeAccountId: "acct_1" }, 3)).toThrow(/Stripe/);
  });
  it("blocks vendors with no legacy documents", () => {
    expect(() => assertManualVerificationAllowed({}, 0)).toThrow();
  });
  it("allows an unambiguously legacy vendor", () => {
    expect(() => assertManualVerificationAllowed({}, 2)).not.toThrow();
  });
});

describe("requirementCategory", () => {
  it("maps keys to coarse categories", () => {
    expect(requirementCategory("company.tax_id")).toBe("Business details");
    expect(requirementCategory("tos_acceptance.date")).toBe("Terms of service");
    expect(requirementCategory("individual.verification.document")).toBe("Identity document");
  });
});
