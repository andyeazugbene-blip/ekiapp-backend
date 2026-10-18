/**
 * Admin-web Users/Vendors pages (19 Oct 2026 request): a deleted/anonymised
 * account or a closed store must never clutter the default admin listing —
 * it's a display filter only, the underlying row is untouched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  userFindMany: vi.fn(async () => []),
  userCount: vi.fn(async () => 0),
  vendorFindMany: vi.fn(async () => []),
  vendorCount: vi.fn(async () => 0),
  orderGroupBy: vi.fn(async () => []),
  orderItemGroupBy: vi.fn(async () => []),
  vendorSubscriptionFindMany: vi.fn(async () => []),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findMany: m.userFindMany, count: m.userCount },
    vendor: { findMany: m.vendorFindMany, count: m.vendorCount },
    order: { groupBy: m.orderGroupBy },
    orderItem: { groupBy: m.orderItemGroupBy },
    vendorSubscription: { findMany: m.vendorSubscriptionFindMany },
  },
}));

import { adminListingsService } from "../modules/admin/admin-listings.service";

beforeEach(() => vi.clearAllMocks());

describe("adminListingsService.listUsers — hides anonymised accounts", () => {
  it("always filters anonymisedAt: null, with no way to ask for anonymised rows", async () => {
    await adminListingsService.listUsers({});
    expect(m.userFindMany.mock.calls[0][0].where).toMatchObject({ anonymisedAt: null });
  });

  it("rejects the old status=anonymised value instead of silently ignoring it", async () => {
    await expect(adminListingsService.listUsers({ status: "anonymised" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("active/suspended filters still combine with the anonymised exclusion", async () => {
    await adminListingsService.listUsers({ status: "suspended" });
    expect(m.userFindMany.mock.calls[0][0].where).toMatchObject({ anonymisedAt: null, isSuspended: true });
  });
});

describe("adminListingsService.listVendors — hides closed stores by default", () => {
  it("excludes closedAt when no account filter is given", async () => {
    await adminListingsService.listVendors({});
    expect(m.vendorFindMany.mock.calls[0][0].where).toMatchObject({ closedAt: null });
  });

  it("does not force closedAt:null when the admin explicitly asks for suspended/closed", async () => {
    await adminListingsService.listVendors({ suspended: "true" });
    expect(m.vendorFindMany.mock.calls[0][0].where).not.toHaveProperty("closedAt");
    expect(m.vendorFindMany.mock.calls[0][0].where).toMatchObject({ isSuspended: true });
  });

  it("does not force closedAt:null when explicitly asking for active-only either", async () => {
    await adminListingsService.listVendors({ suspended: "false" });
    expect(m.vendorFindMany.mock.calls[0][0].where).not.toHaveProperty("closedAt");
  });
});
