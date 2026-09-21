/**
 * Phase F (reliability) — escrowHealthService monitors real outstanding
 * Paystack escrow money and pages ops when it crosses a threshold. Zero
 * test coverage existed for the threshold logic itself (amount OR count),
 * the status breakdown aggregation, or updateProviderConfig's partial-
 * update semantics — all real, money-adjacent operational logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    order: { findMany: vi.fn() },
    escrowProviderConfig: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock("../lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("../lib/sms", () => ({ isSmsConfigured: vi.fn().mockReturnValue(false) }));

import { prisma } from "../lib/prisma";
import { sendEmail } from "../lib/email";
import { escrowHealthService } from "../modules/paystack/escrow-health.service";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.OPS_ALERT_EMAIL;
  m.order.findMany.mockResolvedValue([]);
  m.escrowProviderConfig.findMany.mockResolvedValue([]);
});

// OPS_ALERT_EMAIL is captured into a module-level const at import time, not
// re-read per call — tests that need it set must set the env var BEFORE a
// fresh import, via vi.resetModules() (same pattern already used for
// COMMUNITY_BUY_ORGANISER_PAYOUT_ENABLED in community-buy-diaspora-
// settlement.test.ts). Mocked modules stay the same singleton across
// resetModules(), so the top-level `m` reference above remains valid.
async function importWithOpsEmail(email: string) {
  process.env.OPS_ALERT_EMAIL = email;
  vi.resetModules();
  const mod = await import("../modules/paystack/escrow-health.service");
  return mod.escrowHealthService;
}

describe("escrowHealthService.getHealth — real status breakdown", () => {
  it("aggregates outstanding orders by status, summing amount per status independently", async () => {
    m.order.findMany.mockResolvedValue([
      { status: "PAYMENT_SECURED", totalAmount: 5000, currency: "NGN" },
      { status: "PAYMENT_SECURED", totalAmount: 3000, currency: "NGN" },
      { status: "DISPUTED", totalAmount: 2000, currency: "NGN" },
    ]);

    const health = await escrowHealthService.getHealth();

    expect(health.outstandingOrders).toBe(3);
    expect(health.outstandingAmount).toBe(10000);
    expect(health.statusBreakdown.PAYMENT_SECURED).toEqual({ count: 2, amount: 8000 });
    expect(health.statusBreakdown.DISPUTED).toEqual({ count: 1, amount: 2000 });
  });

  it("defaults currency to NGN when there are no outstanding orders at all", async () => {
    m.order.findMany.mockResolvedValue([]);
    const health = await escrowHealthService.getHealth();
    expect(health.currency).toBe("NGN");
    expect(health.outstandingAmount).toBe(0);
  });

  it("only queries the active escrow statuses — never counts a released or refunded order as outstanding", async () => {
    await escrowHealthService.getHealth();
    const call = m.order.findMany.mock.calls[0][0];
    expect(call.where.status.in).toEqual(["PAYMENT_SECURED", "VENDOR_CONFIRMED", "DISPATCHED", "DISPUTED"]);
    expect(call.where.status.in).not.toContain("REFUNDED");
    expect(call.where.status.in).not.toContain("COMPLETED");
  });
});

describe("escrowHealthService.checkAndAlert — real threshold crossing", () => {
  it("sends no alert and does not even log when there are zero outstanding orders", async () => {
    m.order.findMany.mockResolvedValue([]);
    await escrowHealthService.checkAndAlert();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not alert when outstanding is below both the amount and count thresholds", async () => {
    process.env.OPS_ALERT_EMAIL = "ops@eki.example";
    m.order.findMany.mockResolvedValue([{ status: "PAYMENT_SECURED", totalAmount: 100000, currency: "NGN" }]); // 1 order, ₦1,000 — well under both thresholds
    await escrowHealthService.checkAndAlert();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("alerts when the outstanding AMOUNT alone crosses the threshold, even with few orders", async () => {
    const service = await importWithOpsEmail("ops@eki.example");
    m.order.findMany.mockResolvedValue([{ status: "PAYMENT_SECURED", totalAmount: 60000000, currency: "NGN" }]); // 1 order, but > ₦500k threshold
    await service.checkAndAlert();
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "ops@eki.example" }));
  });

  it("alerts when the outstanding ORDER COUNT alone crosses the threshold, even with a tiny total amount", async () => {
    const service = await importWithOpsEmail("ops@eki.example");
    m.order.findMany.mockResolvedValue(
      Array.from({ length: 11 }, () => ({ status: "PAYMENT_SECURED", totalAmount: 100, currency: "NGN" })),
    ); // 11 orders > 10-order threshold, tiny total amount
    await service.checkAndAlert();
    expect(sendEmail).toHaveBeenCalled();
  });

  it("never sends an email when OPS_ALERT_EMAIL is not configured, even if thresholds are crossed — no invented recipient", async () => {
    m.order.findMany.mockResolvedValue([{ status: "PAYMENT_SECURED", totalAmount: 60000000, currency: "NGN" }]);
    await escrowHealthService.checkAndAlert();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("escrowHealthService.updateProviderConfig — partial update, real 404", () => {
  it("404s when the provider config row doesn't exist", async () => {
    m.escrowProviderConfig.findUnique.mockResolvedValue(null);
    await expect(escrowHealthService.updateProviderConfig("missing-id", { enabled: true })).rejects.toMatchObject({ statusCode: 404 });
    expect(m.escrowProviderConfig.update).not.toHaveBeenCalled();
  });

  it("only writes the fields actually provided — never overwrites an untouched field with undefined", async () => {
    m.escrowProviderConfig.findUnique.mockResolvedValue({ id: "cfg-1" });
    m.escrowProviderConfig.update.mockResolvedValue({ id: "cfg-1", enabled: true });

    await escrowHealthService.updateProviderConfig("cfg-1", { enabled: true });

    expect(m.escrowProviderConfig.update).toHaveBeenCalledWith({ where: { id: "cfg-1" }, data: { enabled: true } });
  });

  it("allows explicitly clearing notes to null — distinguished from 'not provided'", async () => {
    m.escrowProviderConfig.findUnique.mockResolvedValue({ id: "cfg-1" });
    m.escrowProviderConfig.update.mockResolvedValue({ id: "cfg-1" });

    await escrowHealthService.updateProviderConfig("cfg-1", { notes: null });

    expect(m.escrowProviderConfig.update).toHaveBeenCalledWith({ where: { id: "cfg-1" }, data: { notes: null } });
  });

  it("writes multiple provided fields together without dropping any", async () => {
    m.escrowProviderConfig.findUnique.mockResolvedValue({ id: "cfg-1" });
    m.escrowProviderConfig.update.mockResolvedValue({ id: "cfg-1" });

    await escrowHealthService.updateProviderConfig("cfg-1", { enabled: false, payoutSupported: true, protectionWindowHours: 48 });

    expect(m.escrowProviderConfig.update).toHaveBeenCalledWith({
      where: { id: "cfg-1" },
      data: { enabled: false, payoutSupported: true, protectionWindowHours: 48 },
    });
  });
});
