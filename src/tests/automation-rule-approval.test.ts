import { describe, expect, it } from "vitest";
import { assertRuleCanBeActivated } from "../modules/automation/automation-rules.service";

// Owner instruction (2026-10-29): R04's hardcoded, no-override activation
// block was removed — admin-panel rule-state control (same mechanism
// every other automation already uses) replaces the old hidden code gate.
// This rule still defaults to DRAFT (off) via ruleDefaults(); only the
// ability to flip it ACTIVE from the admin panel was restored.
describe("assertRuleCanBeActivated (R04's former hard gate, now a no-op)", () => {
  it("no longer blocks activating DRAFT_PRODUCT_REMINDER (R04)", () => {
    expect(() => assertRuleCanBeActivated("DRAFT_PRODUCT_REMINDER", "ACTIVE")).not.toThrow();
  });

  it("does not block unrelated rules or other transitions either", () => {
    expect(() => assertRuleCanBeActivated("FIRST_SALE", "ACTIVE")).not.toThrow();
    expect(() => assertRuleCanBeActivated("DRAFT_PRODUCT_REMINDER", "PAUSED")).not.toThrow();
  });
});
