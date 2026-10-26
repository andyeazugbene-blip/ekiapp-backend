import { afterEach, describe, expect, it, vi } from "vitest";
import { assertRuleCanBeActivated } from "../modules/automation/automation-rules.service";

afterEach(() => vi.unstubAllEnvs());

describe("R04 enablement gate", () => {
  it("rejects activation while channel ownership, sub-daily timing, and live route QA are unverified", () => {
    expect(() => assertRuleCanBeActivated("DRAFT_PRODUCT_REMINDER", "ACTIVE"))
      .toThrow("R04 cannot be enabled until Acquisition WhatsApp coordination, sub-daily timing, and route delivery are verified");
  });

  it("does not let an approval environment flag bypass the unverified operational dependencies", () => {
    vi.stubEnv("R04_ENABLEMENT_APPROVED", "true");
    expect(() => assertRuleCanBeActivated("DRAFT_PRODUCT_REMINDER", "ACTIVE"))
      .toThrow("R04 cannot be enabled until Acquisition WhatsApp coordination, sub-daily timing, and route delivery are verified");
  });

  it("does not block unrelated rules or non-activation transitions", () => {
    expect(() => assertRuleCanBeActivated("FIRST_SALE", "ACTIVE")).not.toThrow();
    expect(() => assertRuleCanBeActivated("DRAFT_PRODUCT_REMINDER", "PAUSED")).not.toThrow();
  });
});
