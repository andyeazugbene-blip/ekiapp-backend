import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * PAY-03 regression guard: the app never uses "escrow" in user-facing copy —
 * everywhere buyers/vendors actually see this concept it's called "secured"/
 * "protected payment" (see order-confirmation.tsx, orders.tsx,
 * track-order.tsx, order-detail.tsx on the frontend). Internal naming
 * (escrowType column, EscrowProviderConfig table, escrow.service.ts,
 * variable/comment names) is deliberately untouched — this guard is
 * string-literal-scoped, not a blanket ban on the word "escrow" in the repo.
 *
 * Reads the real source files directly (same pattern already used by
 * automation.test.ts's cron-schedule regression guard) rather than
 * exercising the full checkout/dispute call graphs just to reach these
 * branches — the fix here is pure copy, zero logic change, so a text-level
 * guard is the right-sized test.
 */
const ROOT = join(__dirname, "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf-8");
}

describe("PAY-03 — no 'escrow' in user-facing checkout error strings", () => {
  const paystackServiceSrc = readSource("src/modules/paystack/paystack.service.ts");

  it("does not contain any of the 3 old buyer-facing 'Escrow checkout'/'Domestic escrow checkout' error strings", () => {
    expect(paystackServiceSrc).not.toMatch(/throw new AppError\("Escrow checkout/);
    expect(paystackServiceSrc).not.toMatch(/throw new AppError\("Domestic escrow checkout/);
  });

  it("uses the same 'Secured checkout' wording for all 3 checkout validation errors", () => {
    expect(paystackServiceSrc).toContain('"Secured checkout supports one vendor per order. Please check out each vendor separately."');
    expect(paystackServiceSrc).toContain('"Secured checkout is not available because the vendor country is not configured"');
    expect(paystackServiceSrc).toContain('"Secured checkout only supports items from a single vendor country"');
    expect(paystackServiceSrc).toContain('"Secured checkout is not available for this vendor country yet"');
  });
});

describe("PAY-03 — no 'escrow' in the vendor dispute-notification body", () => {
  const disputeServiceSrc = readSource("src/modules/paystack/dispute.service.ts");

  it("does not contain the old 'The escrow is frozen until resolved' body text", () => {
    expect(disputeServiceSrc).not.toContain("The escrow is frozen until resolved");
  });

  it("uses 'Payment protection remains active until resolved' instead", () => {
    expect(disputeServiceSrc).toContain("Payment protection remains active until resolved");
  });
});
