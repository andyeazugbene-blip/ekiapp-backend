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
