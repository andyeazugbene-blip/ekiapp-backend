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
];

// Automations a vendor can see/toggle from the Automation Center. The three
// CAMPAIGN_* types are buyer-facing, campaign-lifecycle-triggered
// notifications with no vendor on/off concept — mirrors the frontend's
// VENDOR_AUTOMATION_TYPES in services/automationService.ts exactly. Before
// this list existed, listVendorAutomations() returned all AutomationType
// keys (including CAMPAIGN_*), so tapping one of those three cards in the
// Automation Center opened a detail screen for a type the frontend's own
// validity check rejected, showing "This automation is not available."
export const VENDOR_TOGGLEABLE_AUTOMATION_TYPES: AutomationType[] = [
  "FIRST_SALE",
  "CART_RECOVERY",
  "BUYER_WIN_BACK",
  "REVIEW_REQUEST",
  "LOW_STOCK_ALERT",
  "BUYER_REFERRAL",
  "PAYMENT_RECOVERY",
  "RENEWAL_REMINDER",
  "PRICE_APPROVAL_REMINDER",
];
