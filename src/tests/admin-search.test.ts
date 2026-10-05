/** Global admin search (handbook 2.1 L132): permission-filtered fan-out. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { models, perms } = vi.hoisted(() => {
  const mk = () => ({ findMany: vi.fn() });
  return {
    models: { user: mk(), vendor: mk(), order: mk(), payment: mk(), communityCampaign: mk(), buyerSubscription: mk() },
    perms: { value: ["admin.*"] as string[] },
  };
});

vi.mock("../lib/prisma", () => ({ prisma: models }));
vi.mock("../modules/admin/admin-roles.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../modules/admin/admin-roles.service")>()),
  adminRolesService: { userPermissions: vi.fn(async () => perms.value) },
}));

import { adminSearchService } from "../modules/admin/admin-search.service";

beforeEach(() => {
  for (const m of Object.values(models)) m.findMany.mockReset().mockResolvedValue([]);
  perms.value = ["admin.*"];
});

describe("adminSearchService.search", () => {
  it("does not query anything for a query shorter than 2 characters", async () => {
    const res = await adminSearchService.search("a1", "x");
    expect(res.groups).toEqual([]);
    expect(models.user.findMany).not.toHaveBeenCalled();
  });

  it("only searches entity groups the admin may read, and reports the restricted ones", async () => {
    perms.value = ["orders.read"];
    models.order.findMany.mockResolvedValue([
      { id: "o1", orderNumber: "ORD-1", status: "PAID", totalAmount: 1250, currency: "GBP", isTest: false, buyer: { name: "Ada" } },
    ]);
    const res = await adminSearchService.search("a1", "ORD");
    expect(models.user.findMany).not.toHaveBeenCalled();
    expect(models.vendor.findMany).not.toHaveBeenCalled();
    expect(models.communityCampaign.findMany).not.toHaveBeenCalled();
    expect(models.order.findMany).toHaveBeenCalled();
    expect(models.payment.findMany).toHaveBeenCalled();
    expect([...res.restricted].sort()).toEqual(["campaigns", "users", "vendors"]);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0].results[0]).toMatchObject({ href: "/orders/o1", title: "Order ORD-1" });
  });

  it("super admin searches all groups; each returns at most 5 and deep links", async () => {
    models.user.findMany.mockResolvedValue([{ id: "u1", name: "Bola", email: "b@x.com", role: "BUYER", isTest: true }]);
    const res = await adminSearchService.search("a1", "bola");
    expect(models.user.findMany.mock.calls[0][0].take).toBe(5);
    expect(res.restricted).toEqual([]);
    expect(res.groups[0].results[0]).toMatchObject({ href: "/users/u1", isTest: true });
  });

  it("one failing group is reported in errors and does not fail the search", async () => {
    models.vendor.findMany.mockRejectedValue(new Error("boom"));
    models.user.findMany.mockResolvedValue([{ id: "u1", name: "Bola", email: "b@x.com", role: "BUYER", isTest: false }]);
    const res = await adminSearchService.search("a1", "bola");
    expect(res.errors).toEqual(["vendors"]);
    expect(res.groups.map((g) => g.key)).toEqual(["users"]);
  });
});
