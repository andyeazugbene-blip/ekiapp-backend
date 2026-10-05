import { describe, expect, it } from "vitest";
import { deriveVendorSubscriptionState } from "../modules/subscriptions/vendor-subscription-state";

const DAY = 86_400_000;
const now = new Date("2026-10-05T12:00:00Z");
const at = (days: number) => new Date(now.getTime() + days * DAY);

const base = { plan: "GROWTH", status: "ACTIVE", stripeSubscriptionId: "sub_1" };

describe("vendor subscription lifecycle (Stripe-sourced)", () => {
  it("no subscription / legacy free", () => {
    expect(deriveVendorSubscriptionState(null, now).lifecycle).toBe("NO_SUBSCRIPTION");
    expect(deriveVendorSubscriptionState({ plan: "FREE", status: "ACTIVE" }, now).lifecycle).toBe("NO_SUBSCRIPTION");
  });

  it("trial active: 14-day window, days remaining counted up to the day", () => {
    const s = deriveVendorSubscriptionState({ ...base, trialStartedAt: at(0), trialEndsAt: at(14) }, now);
    expect(s.lifecycle).toBe("TRIAL_ACTIVE");
    expect(s.inTrial).toBe(true);
    expect(s.trialDaysRemaining).toBe(14);
    expect(s.billingStarted).toBe(false);
    expect((s.trialEndsAt!.getTime() - s.trialStartedAt!.getTime()) / DAY).toBe(14);
  });

  it("trial ending: <= 3 days left", () => {
    expect(deriveVendorSubscriptionState({ ...base, trialStartedAt: at(-11), trialEndsAt: at(3) }, now).lifecycle).toBe("TRIAL_ENDING");
    expect(deriveVendorSubscriptionState({ ...base, trialStartedAt: at(-11), trialEndsAt: at(3.2) }, now).lifecycle).toBe("TRIAL_ACTIVE");
    expect(deriveVendorSubscriptionState({ ...base, trialStartedAt: at(-13.5), trialEndsAt: at(0.5) }, now).trialDaysRemaining).toBe(1);
  });

  it("trial converted to paid: trial over and a new billing period exists", () => {
    const s = deriveVendorSubscriptionState({ ...base, trialStartedAt: at(-20), trialEndsAt: at(-6), currentPeriodEnd: at(24) }, now);
    expect(s.lifecycle).toBe("PAID_ACTIVE");
    expect(s.inTrial).toBe(false);
    expect(s.billingStarted).toBe(true);
    expect(s.trialDaysRemaining).toBe(0);
  });

  it("trial expired without conversion is flagged, not shown as paid", () => {
    const s = deriveVendorSubscriptionState({ ...base, trialStartedAt: at(-20), trialEndsAt: at(-6), currentPeriodEnd: at(-6) }, now);
    expect(s.lifecycle).toBe("TRIAL_EXPIRED");
    expect(s.billingStarted).toBe(false);
  });

  it("webhook lag grace: trial ended < 1 day ago is not yet flagged expired", () => {
    const s = deriveVendorSubscriptionState({ ...base, trialStartedAt: at(-14.5), trialEndsAt: at(-0.5), currentPeriodEnd: at(-0.5) }, now);
    expect(s.lifecycle).toBe("PAID_ACTIVE");
  });

  it("paid subscription with no trial", () => {
    const s = deriveVendorSubscriptionState({ ...base, currentPeriodEnd: at(10) }, now);
    expect(s.lifecycle).toBe("PAID_ACTIVE");
    expect(s.billingStarted).toBe(true);
  });

  it("failed renewal after the trial = payment failed; failure during the trial does not claim billing started", () => {
    expect(deriveVendorSubscriptionState({ ...base, status: "PAST_DUE", trialEndsAt: at(-6), currentPeriodEnd: at(5) }, now)).toMatchObject({ lifecycle: "PAYMENT_FAILED", billingStarted: true });
    expect(deriveVendorSubscriptionState({ ...base, status: "PAST_DUE", trialEndsAt: at(5) }, now)).toMatchObject({ lifecycle: "PAYMENT_FAILED", billingStarted: false });
  });

  it("cancellation (in or after a trial) is terminal and not 'in trial'", () => {
    const s = deriveVendorSubscriptionState({ ...base, status: "CANCELLED", trialEndsAt: at(5) }, now);
    expect(s.lifecycle).toBe("CANCELLED");
    expect(s.inTrial).toBe(false);
  });

  it("checkout expiry", () => {
    expect(deriveVendorSubscriptionState({ ...base, status: "EXPIRED" }, now).lifecycle).toBe("EXPIRED");
  });

  it("accepts ISO strings and ignores invalid dates", () => {
    const s = deriveVendorSubscriptionState({ ...base, trialStartedAt: "nope", trialEndsAt: at(5).toISOString() }, now);
    expect(s.trialStartedAt).toBeNull();
    expect(s.inTrial).toBe(true);
  });
});
