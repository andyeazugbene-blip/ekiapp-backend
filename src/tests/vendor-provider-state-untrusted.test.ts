import { describe, expect, it } from "vitest";
import { validateUpdateVendorInput } from "../modules/vendors/vendors.validation";

describe("client-supplied provider/verification state is never accepted", () => {
  it("vendor self-update drops verification, Stripe and readiness fields", () => {
    const out = validateUpdateVendorInput({
      storeName: "My Store",
      verificationStatus: "VERIFIED",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      stripeAccountId: "acct_evil",
      stripeAccountStatus: "active",
      isSuspended: false,
      paymentReady: true,
      payoutReady: true,
      isTest: true,
      closedAt: null,
    }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["storeName"]);
  });

  it("an update containing ONLY privileged fields is rejected as empty", () => {
    expect(() => validateUpdateVendorInput({ verificationStatus: "VERIFIED", stripeChargesEnabled: true })).toThrow(/No fields/);
  });
});
