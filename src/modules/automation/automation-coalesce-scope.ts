/**
 * Bug fix 2026-10-11 ("do not send multiple non-urgent onboarding/
 * promotional notifications together" — the reported screenshot showed
 * "Low stock alert" and "Get your first order" both landing in the same
 * minute). A single sweep invocation (automationDetectors.runSweep())
 * runs several detectors in sequence; without this, two different
 * detectors could each independently decide the SAME vendor is eligible
 * for a non-urgent nudge and both send, right next to each other.
 *
 * Request-scoped (one sweep run = one scope), same AsyncLocalStorage
 * pattern as shared/utils/test-records.ts. The FIRST non-urgent type to
 * claim a given recipient within one sweep wins; detectors run in the
 * priority order automation.detectors.ts's runSweep() defines, so that
 * order IS the priority rule. A later type for the same recipient in the
 * same run is suppressed with reason "coalesced_same_run" — it is not
 * lost, just deferred: eligibility is re-evaluated fresh on the next
 * sweep since every detector here is a live state check, not a
 * one-shot queue.
 *
 * Transactional types (payment recovery, checkout follow-up, subscription
 * renewal/price-approval reminders) are NEVER subject to this — they
 * bypass the claim entirely, see TRANSACTIONAL_AUTOMATION_TYPES.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<Set<string>>();

/** Wrap one sweep invocation so detectors inside it share one coalescing scope. */
export function runWithCoalesceScope<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run(new Set<string>(), fn);
}

/**
 * Claims `recipientUserId` for a non-urgent send in the current scope.
 * Returns true if this call is the first claim this sweep (go ahead and
 * send), false if someone already claimed this recipient this sweep
 * (suppress). Outside a runWithCoalesceScope() call (e.g. a single job
 * triggered manually, a retry) there is no active scope, and every call
 * returns true — coalescing only applies across detectors sharing one
 * real sweep invocation, never as a surprise block on a standalone call.
 */
export function claimRecipientForNonUrgentSend(recipientUserId: string): boolean {
  const claimed = storage.getStore();
  if (!claimed) return true;
  if (claimed.has(recipientUserId)) return false;
  claimed.add(recipientUserId);
  return true;
}

export const TRANSACTIONAL_AUTOMATION_TYPES: ReadonlySet<string> = new Set([
  "PAYMENT_RECOVERY",
  "CHECKOUT_PAYMENT_FOLLOW_UP",
  "RENEWAL_REMINDER",
  "PRICE_APPROVAL_REMINDER",
]);
