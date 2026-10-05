/**
 * Vendor subscription lifecycle, derived ONLY from persisted Stripe-sourced fields
 * (status, trialStartedAt/trialEndsAt from Stripe trial_start/trial_end, period dates).
 * Nothing here charges, extends or invents a trial: Stripe is the source of truth and the
 * webhook handlers keep these columns current. Pure function => fully unit-testable.
 *
 * Trial length is 14 days (GROWTH_TRIAL_DAYS in subscriptions.service.ts). Dates are
 * absolute instants (UTC); callers format them with an explicit timezone.
 */

export type VendorSubscriptionLifecycle =
  | "NO_SUBSCRIPTION"      // no record, or the legacy free plan with no Stripe subscription
  | "TRIAL_ACTIVE"         // inside the trial window
  | "TRIAL_ENDING"         // inside the window with <= 3 days left (trial_will_end window)
  | "TRIAL_EXPIRED"        // trial window passed but Stripe has not yet moved the subscription (webhook lag) or it never converted
  | "PAID_ACTIVE"          // billing active (after a trial, or no trial)
  | "PAYMENT_FAILED"       // past_due / unpaid
  | "CANCELLED"            // cancelled (during or after a trial)
  | "EXPIRED";             // checkout expired / incomplete_expired

export interface VendorSubscriptionStateInput {
  plan?: string | null;
  status?: string | null;           // ACTIVE | PAST_DUE | CANCELLED | EXPIRED
  stripeSubscriptionId?: string | null;
  trialStartedAt?: Date | string | null;
  trialEndsAt?: Date | string | null;
  currentPeriodEnd?: Date | string | null;
}

export const TRIAL_ENDING_WINDOW_DAYS = 3;
const DAY_MS = 86_400_000;

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function deriveVendorSubscriptionState(
  input: VendorSubscriptionStateInput | null | undefined,
  now: Date = new Date(),
): {
  lifecycle: VendorSubscriptionLifecycle;
  inTrial: boolean;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  trialDaysRemaining: number;
  /** True once real billing applies (Stripe subscription exists and the trial, if any, is over). */
  billingStarted: boolean;
} {
  const trialStartedAt = toDate(input?.trialStartedAt);
  const trialEndsAt = toDate(input?.trialEndsAt);
  const empty = { inTrial: false, trialStartedAt, trialEndsAt, trialDaysRemaining: 0, billingStarted: false };

  if (!input || (!input.stripeSubscriptionId && (!input.plan || input.plan === "FREE"))) {
    return { lifecycle: "NO_SUBSCRIPTION", ...empty };
  }

  switch (input.status) {
    case "CANCELLED":
      return { lifecycle: "CANCELLED", ...empty };
    case "EXPIRED":
      return { lifecycle: "EXPIRED", ...empty };
    case "PAST_DUE":
      return { lifecycle: "PAYMENT_FAILED", ...empty, billingStarted: !(trialEndsAt && trialEndsAt > now) };
    default:
      break;
  }

  if (trialEndsAt && trialEndsAt.getTime() > now.getTime()) {
    const remainingMs = trialEndsAt.getTime() - now.getTime();
    const days = Math.ceil(remainingMs / DAY_MS);
    return {
      lifecycle: days <= TRIAL_ENDING_WINDOW_DAYS ? "TRIAL_ENDING" : "TRIAL_ACTIVE",
      inTrial: true,
      trialStartedAt,
      trialEndsAt,
      trialDaysRemaining: days,
      billingStarted: false,
    };
  }

  // Trial over (or never had one). Stripe flips a converted subscription to active and sends
  // updates; a stale record whose trial ended > 1 day ago with no new period is flagged expired.
  if (trialEndsAt) {
    const periodEnd = toDate(input.currentPeriodEnd);
    const converted = !!periodEnd && periodEnd.getTime() > trialEndsAt.getTime();
    if (!converted && now.getTime() - trialEndsAt.getTime() > DAY_MS) {
      return { lifecycle: "TRIAL_EXPIRED", ...empty };
    }
  }
  return { lifecycle: "PAID_ACTIVE", ...empty, billingStarted: true };
}
