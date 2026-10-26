import { afterEach, describe, expect, it, vi } from "vitest";
import { assertRuleCanBeActivated } from "../modules/automation/automation-rules.service";

afterEach(() => vi.unstubAllEnvs());

describe("R04 enablement gate", () => {
  it("rejects activation while the client copy and policy have not been approved", () => {
    vi.stubEnv("R04_ENABLEMENT_APPROVED", "false");
    expect(() => assertRuleCanBeActivated("DRAFT_PRODUCT_REMINDER", "ACTIVE"))
      .toThrow("R04 cannot be enabled until its exact client copy and policy are approved");
  });

  it("permits activation only when the explicit approval gate is true", () => {
    vi.stubEnv("R04_ENABLEMENT_APPROVED", "true");
    expect(() => assertRuleCanBeActivated("DRAFT_PRODUCT_REMINDER", "ACTIVE")).not.toThrow();
  });

  it("does not block unrelated rules or non-activation transitions", () => {
    vi.stubEnv("R04_ENABLEMENT_APPROVED", "false");
    expect(() => assertRuleCanBeActivated("FIRST_SALE", "ACTIVE")).not.toThrow();
    expect(() => assertRuleCanBeActivated("DRAFT_PRODUCT_REMINDER", "PAUSED")).not.toThrow();
  });
});
