/**
 * Handbook §3 Action Centre + §2.1 L139 test-record isolation: honest
 * server-side aggregates, per-currency values, per-section failure isolation,
 * permission-filtered sections, and isTest exclusion by default.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { models, perms } = vi.hoisted(() => {
  const names = [
    "payment", "payoutRequest", "order", "dispute", "vendor", "communityCampaign", "supplierFulfilmentAlert",
    "campaignRefund", "renewal", "automationRun", "scheduledCommunication", "message", "conversation", "user", "webhookEvent",
  ];
  const models: Record<string, Record<string, any>> = {};
  for (const n of names) {
    models[n] = { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() };
  }
  return { models, perms: { value: ["admin.*"] as string[] } };
});

vi.mock("../lib/prisma", () => ({ prisma: models }));
vi.mock("../modules/admin/admin-roles.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../modules/admin/admin-roles.service")>()),
  adminRolesService: { userPermissions: vi.fn(async () => perms.value) },
}));

import { getActionCentre, mergeMoney } from "../modules/admin/admin-action-centre.service";

function resetDefaults() {
  for (const m of Object.values(models)) {
    m.groupBy.mockReset().mockResolvedValue([]);
    m.count.mockReset().mockResolvedValue(0);
    m.findMany.mockReset().mockResolvedValue([]);
    m.aggregate.mockReset().mockResolvedValue({ _min: {}, _max: {}, _sum: {} });
  }
  perms.value = ["admin.*"];
}

beforeEach(resetDefaults);

describe("getActionCentre — honest aggregates", () => {
  it("groups failed-payment value by ORIGINAL currency and never sums across currencies", async () => {
    const t1 = new Date("2026-10-01T10:00:00Z");
    const t2 = new Date("2026-09-29T10:00:00Z");
    models.payment.groupBy.mockResolvedValue([
      { currency: "GBP", _count: { _all: 2 }, _sum: { amount: 3000 }, _min: { createdAt: t1 } },
      { currency: "EUR", _count: { _all: 1 }, _sum: { amount: 500 }, _min: { createdAt: t2 } },
    ]);
    const res = await getActionCentre("admin1");
    const s = res.sections.find((x) => x.key === "paymentFailures")!;
    expect(s.count).toBe(3);
    expect(s.values).toEqual(expect.arrayContaining([
      { currency: "GBP", amountMinor: 3000, count: 2 },
      { currency: "EUR", amountMinor: 500, count: 1 },
    ]));
    expect(s.oldestAt).toBe(t2.toISOString());
    expect(s.href).toBe("/payments?status=FAILED");
    expect(s.severity).toBe("high");
  });

  it("isolates a failing section: it reports unavailable while others still compute", async () => {
    models.dispute.count.mockRejectedValue(new Error("db down"));
    models.vendor.count.mockResolvedValue(4);
    const res = await getActionCentre("admin1");
    const disputes = res.sections.find((x) => x.key === "disputes")!;
    expect(disputes.state).toBe("unavailable");
    expect(disputes.error).toBe("Data unavailable");
    expect(res.sections.find((x) => x.key === "vendorReadiness")!.count).toBe(4);
    expect(res.sections[res.sections.length - 1].state).toBe("unavailable");
    expect(res.badges.disputes).toBeUndefined();
  });

  it("omits sections the admin cannot read and reports the viewer permissions", async () => {
    perms.value = ["verification.read", "disputes.read"];
    const res = await getActionCentre("admin1");
    expect(res.sections.map((s) => s.key).sort()).toEqual(["disputes", "verification"]);
    expect(res.kpis).toBeNull();
    expect(res.viewerPermissions).toEqual(["verification.read", "disputes.read"]);
  });

  it("orders sections by severity then count and exposes queue badges", async () => {
    models.vendor.groupBy.mockResolvedValue([{ stripeIdentityStatus: "requires_input", _count: { _all: 3 } }]);
    models.dispute.count.mockResolvedValue(2);
    const res = await getActionCentre("admin1");
    const keys = res.sections.map((s) => s.key);
    expect(keys.indexOf("disputes")).toBeLessThan(keys.indexOf("verification"));
    expect(res.badges.verification).toBe(3);
    expect(res.badges.disputes).toBe(2);
  });
});

describe("getActionCentre — test-record exclusion", () => {
  it("excludes isTest records by default across payments, orders, vendors and users", async () => {
    await getActionCentre("admin1");
    expect(models.payment.groupBy.mock.calls[0][0].where).toMatchObject({ isTest: false });
    expect(models.vendor.count.mock.calls[0][0].where).toMatchObject({ isTest: false });
    // KPI GMV groupBy is the last order.groupBy call
    const kpiOrderWhere = models.order.groupBy.mock.calls.at(-1)![0].where;
    expect(kpiOrderWhere).toMatchObject({ isTest: false });
    expect(models.user.count).toHaveBeenCalledWith({ where: { role: "BUYER", isTest: false } });
    // relation-based filter for payouts
    expect(models.payoutRequest.groupBy.mock.calls[0][0].where).toMatchObject({ vendor: { isTest: false } });
  });

  it("includes test records when includeTest=true (no isTest filter anywhere)", async () => {
    const res = await getActionCentre("admin1", { includeTest: true });
    expect(res.includeTest).toBe(true);
    expect(models.payment.groupBy.mock.calls[0][0].where).not.toHaveProperty("isTest");
    expect(models.vendor.count.mock.calls[0][0].where).not.toHaveProperty("isTest");
    expect(models.payoutRequest.groupBy.mock.calls[0][0].where).not.toHaveProperty("vendor");
    expect(models.user.count).toHaveBeenCalledWith({ where: { role: "BUYER" } });
  });
});

describe("mergeMoney", () => {
  it("merges same-currency rows and keeps currencies separate", () => {
    const out = mergeMoney(
      [{ currency: "GBP", amountMinor: 100, count: 1 }],
      [{ currency: "GBP", amountMinor: 50, count: 2 }, { currency: "NGN", amountMinor: 9, count: 1 }],
    );
    expect(out).toEqual([
      { currency: "GBP", amountMinor: 150, count: 3 },
      { currency: "NGN", amountMinor: 9, count: 1 },
    ]);
  });
});
