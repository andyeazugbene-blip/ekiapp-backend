import type { AutomationType } from "@prisma/client";

export interface ScheduleAutomationInput {
  type: AutomationType;
  recipientUserId: string;
  vendorId?: string | null;
  // Uniquely identifies the *thing* this run is about (a cart, an order, a
  // referral, a product) so the same trigger can never fire twice for the
  // same subject — see AutomationRun.dedupeKey.
  subjectKey: string;
  // Days a recipient must go without another run of this same type before
  // they're eligible again — separate from the dedupeKey, which prevents
  // the exact same subject firing twice.
  frequencyCapDays?: number;
  // Marketing-flavored automations require marketingConsentAt; operational/
  // transactional ones (low stock, payment recovery, renewal reminders) do
  // not — see isEligible() for the exact list.
  requiresMarketingConsent: boolean;
  // Transactional notices (e.g. trial ending) are not held back by quiet hours.
  bypassQuietHours?: boolean;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface AutomationEligibilityResult {
  eligible: boolean;
  reason?: string;
}

export const MARKETING_AUTOMATION_TYPES: AutomationType[] = [
  "CART_RECOVERY",
  "BUYER_WIN_BACK",
  "REVIEW_REQUEST",
  "BUYER_REFERRAL",
  "REORDER_REMINDER",
  "CHECKOUT_PAYMENT_FOLLOW_UP",
];

// Final Client Decision 4 §Automations — the 11 required modules split into
// vendor-controlled (8) and Eki-managed (3):
//
// VENDOR-CONTROLLED (vendor can enable/disable/configure):
//   1. FIRST_SALE
//   2. CART_RECOVERY
//   3. BUYER_WIN_BACK
//   4. REORDER_REMINDER         (new — triggers post-delivery)
//   5. CHECKOUT_PAYMENT_FOLLOW_UP (new — triggers on failed/abandoned checkout)
//   6. BUYER_REFERRAL
//   7. REVIEW_REQUEST
//   8. LOW_STOCK_ALERT
//
// EKI-MANAGED (displayed "Managed by Eki", no vendor toggle):
//   9.  PAYMENT_RECOVERY
//   10. RENEWAL_REMINDER
//   11. PRICE_APPROVAL_REMINDER
//
// REGISTRATION_REMINDER (new 2026-10-22, corrected 2026-10-23: nudges a
// VENDOR who never created their Vendor profile, not an email-verification
// step — see detectRegistrationReminder's doc comment) is deliberately in
// NEITHER list above and not returned by listVendorAutomations(): there is
// no Vendor row (and so no vendorId) for its recipient YET — that's the
// whole point of the automation — so it can't be a per-vendor Automation
// Centre toggle like the 11 above, same reason VENDOR_TRIAL_ENDING
// (Stripe-triggered, not detector-driven) is also absent from both lists.
// It still goes through automationService.scheduleAutomation() and gets an
// AutomationRule row via ensureRules() for admin visibility/pause control
// — it's just not vendor-facing (there's no vendor account yet to show it
// to).
//
// The CAMPAIGN_* types (MILESTONE / DEADLINE / REFUND_UPDATE) are
// buyer-facing campaign-lifecycle events, not automation-centre modules.

export const VENDOR_TOGGLEABLE_AUTOMATION_TYPES: AutomationType[] = [
  "FIRST_SALE",
  // Spec R03/R05/R06 (2026-10-25) — split out of FIRST_SALE's old merged
  // stage-switching copy. Unlike REGISTRATION_REMINDER (R01), these three
  // DO have a Vendor row/vendorId by the time they're eligible, so they
  // belong in the vendor-facing toggle list same as FIRST_SALE.
  "FIRST_PRODUCT_REMINDER",
  "DELIVERY_SETUP_REMINDER",
  "VERIFICATION_REMINDER",
  "CART_RECOVERY",
  "BUYER_WIN_BACK",
  "REORDER_REMINDER",
  "CHECKOUT_PAYMENT_FOLLOW_UP",
  "BUYER_REFERRAL",
  "REVIEW_REQUEST",
  "LOW_STOCK_ALERT",
];

// These run on Eki's behalf — vendor can see activity but cannot toggle.
export const EKI_MANAGED_AUTOMATION_TYPES: AutomationType[] = [
  "PAYMENT_RECOVERY",
  "RENEWAL_REMINDER",
  "PRICE_APPROVAL_REMINDER",
];
