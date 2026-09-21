/**
 * Phase 3 fix — the daily cron sweep ran two entirely separate low-stock
 * alert paths every day: "automation-sweep" (detectLowStockAlert(), real
 * dedup + vendor toggle + multi-channel) AND a standalone "stock-alerts" job
 * that sent a raw, un-dedup'd, non-toggleable email for the exact same
 * condition. This proves the duplicate job route is gone while the real one
 * (and the combined daily-sweep entry point) still exist.
 */
import { describe, it, expect } from "vitest";

import { internalRouter } from "../modules/internal/internal.routes";

function registeredPaths(): string[] {
  return (internalRouter.stack as any[])
    .filter((layer) => layer.route)
    .map((layer) => layer.route.path as string);
}

describe("internal job routes — low-stock duplication removed", () => {
  it("no longer registers a standalone stock-alerts job route", () => {
    expect(registeredPaths()).not.toContain("/jobs/stock-alerts");
  });

  it("still registers the automation sweep (the sole remaining low-stock path) and the combined daily sweep", () => {
    const paths = registeredPaths();
    expect(paths).toContain("/jobs/automation-sweep");
    expect(paths).toContain("/jobs/daily-sweep");
  });
});
