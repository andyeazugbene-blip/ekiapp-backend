/**
 * Community Buy Workstream 1 (identity/capability foundation) — the
 * mandatory test matrix from the approved plan: capability derivation,
 * the exact-authorization-matrix-preservation guards, the Vendor-
 * independent Supplier Centre onboarding path, and the specific role-trap
 * regressions this workstream exists to close.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── 1. Capability derivation (toAuthUser) ─────────────────────────────
// canSelfSupply is deliberately independent of canSupply — this is the
// exact bug caught during plan review (self-supply needs no
// SupplierAccount/Vendor relationship at all).

vi.mock("../lib/prisma", () => ({ prisma: {} }));
vi.mock("../lib/email-queue", () => ({ enqueueEmail: vi.fn() }));
vi.mock("../lib/email-templates", () => ({ emailTemplates: { welcomeVendor: vi.fn(), welcomeBuyer: vi.fn() } }));

import { toAuthUser } from "../modules/auth/auth.service";

function baseUser(overrides: Partial<Parameters<typeof toAuthUser>[0]> = {}) {
  return {
    id: "user-1",
    email: "u@x.com",
    name: "U",
    phone: null,
    avatar: null,
    country: null,
    referralCode: null,
    isSuspended: false,
    suspendedReason: null,
    role: "BUYER" as const,
    trustScore: 50,
    createdAt: new Date(),
    vendor: null,
    supplierAccount: null,
    ...overrides,
  };
}

describe("toAuthUser — capability derivation", () => {
  it("a fresh buyer: canBuy, canOrganise, canSelfSupply all true; canSell, canSupply, canReceiveSupplierPayouts all false", () => {
    const authUser = toAuthUser(baseUser() as never);
    expect(authUser.capabilities).toEqual({
      canBuy: true,
      canOrganise: true,
      canSell: false,
      canSupply: false,
      canSelfSupply: true,
      canReceiveSupplierPayouts: false,
    });
    expect(authUser.lastDestination).toBe("BUY");
  });

  it("a buyer with a PENDING (unverified) Vendor: canSell stays false, hasVendor stays true, Supplier Centre capabilities unaffected", () => {
    const authUser = toAuthUser(baseUser({
      vendor: { storeName: "S", storeSlug: "s", description: null, businessType: null, sellerRegion: null, city: null, avatar: null, coverImage: null, currency: "GBP", verificationStatus: "PENDING" },
    }) as never);
    expect(authUser.hasVendor).toBe(true);
    expect(authUser.capabilities.canSell).toBe(false);
    expect(authUser.capabilities.canBuy).toBe(true);
    expect(authUser.capabilities.canOrganise).toBe(true);
    expect(authUser.lastDestination).toBe("SELL");
  });

  it("a VERIFIED vendor: canSell becomes true", () => {
    const authUser = toAuthUser(baseUser({
      vendor: { storeName: "S", storeSlug: "s", description: null, businessType: null, sellerRegion: null, city: null, avatar: null, coverImage: null, currency: "GBP", verificationStatus: "VERIFIED" },
    }) as never);
    expect(authUser.capabilities.canSell).toBe(true);
  });

  it("canSelfSupply is true even for a plain buyer with no SupplierAccount at all — self-supply needs no supplier relationship", () => {
    const authUser = toAuthUser(baseUser() as never);
    expect(authUser.capabilities.canSelfSupply).toBe(true);
    expect(authUser.capabilities.canSupply).toBe(false);
  });

  it("an APPROVED SupplierAccount grants canSupply, independent of any Vendor state", () => {
    const authUser = toAuthUser(baseUser({
      supplierAccount: { supplierState: "APPROVED", chargesEnabled: true, payoutsEnabled: true },
    }) as never);
    expect(authUser.capabilities.canSupply).toBe(true);
    expect(authUser.capabilities.canSelfSupply).toBe(true);
    expect(authUser.capabilities.canReceiveSupplierPayouts).toBe(true);
    expect(authUser.lastDestination).toBe("SUPPLY");
  });

  it("canReceiveSupplierPayouts is false when approved but Stripe charges/payouts aren't enabled yet", () => {
    const authUser = toAuthUser(baseUser({
      supplierAccount: { supplierState: "APPROVED", chargesEnabled: false, payoutsEnabled: false },
    }) as never);
    expect(authUser.capabilities.canSupply).toBe(true);
    expect(authUser.capabilities.canReceiveSupplierPayouts).toBe(false);
  });

  it("a merely UNDER_REVIEW SupplierAccount does not grant canSupply", () => {
    const authUser = toAuthUser(baseUser({
      supplierAccount: { supplierState: "UNDER_REVIEW", chargesEnabled: false, payoutsEnabled: false },
    }) as never);
    expect(authUser.capabilities.canSupply).toBe(false);
  });
});

// ─── 2. Guard matrix — exact preservation of the original authorization
// matrix. requireVendorProfile()/requireVendorProfileOrAdmin() must match
// requireRole("VENDOR")/requireRole("VENDOR","ADMIN") exactly: buyer
// denied, vendor allowed, admin denied on VENDOR-only routes; buyer
// denied, vendor allowed, admin allowed on VENDOR-or-ADMIN routes. ────────

import { requireApprovedSupplier, requireApprovedSupplierForOwnCampaign, requireVendorProfile, requireVendorProfileOrAdmin } from "../middlewares/require-capability";
import { prisma } from "../lib/prisma";

const p = vi.mocked(prisma, true) as any;

function mockReqResNext(user: { id: string; role: "BUYER" | "VENDOR" | "ADMIN" } | undefined) {
  const request: any = { user };
  const response: any = {};
  const next = vi.fn();
  return { request, response, next };
}

describe("requireVendorProfile — exact replacement for requireRole(\"VENDOR\")", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    p.vendor = { findUnique: vi.fn() };
  });

  it("F: buyer with no Vendor row -> denied (403), matching the old role check exactly", async () => {
    p.vendor.findUnique.mockResolvedValue(null);
    const { request, response, next } = mockReqResNext({ id: "buyer-1", role: "BUYER" });
    await requireVendorProfile()(request, response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it("F: a BUYER who has opened a store (has a Vendor row, role still BUYER post-Workstream-1) -> allowed", async () => {
    p.vendor.findUnique.mockResolvedValue({ id: "vendor-1" });
    const { request, response, next } = mockReqResNext({ id: "buyer-with-store", role: "BUYER" });
    await requireVendorProfile()(request, response, next);
    expect(next).toHaveBeenCalledWith(); // called with no args = passed through
  });

  it("F: ADMIN with no Vendor row of their own -> denied, exactly as before (role was never simultaneously VENDOR and ADMIN)", async () => {
    p.vendor.findUnique.mockResolvedValue(null);
    const { request, response, next } = mockReqResNext({ id: "admin-1", role: "ADMIN" });
    await requireVendorProfile()(request, response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});

describe("requireVendorProfileOrAdmin — exact replacement for requireRole(\"VENDOR\", \"ADMIN\")", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    p.vendor = { findUnique: vi.fn() };
  });

  it("G: buyer with no Vendor -> denied", async () => {
    p.vendor.findUnique.mockResolvedValue(null);
    const { request, response, next } = mockReqResNext({ id: "buyer-1", role: "BUYER" });
    await requireVendorProfileOrAdmin()(request, response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it("G: vendor with a Vendor row -> allowed", async () => {
    p.vendor.findUnique.mockResolvedValue({ id: "vendor-1" });
    const { request, response, next } = mockReqResNext({ id: "vendor-1", role: "VENDOR" });
    await requireVendorProfileOrAdmin()(request, response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("G: admin -> allowed without needing a Vendor row (no DB lookup even performed)", async () => {
    const { request, response, next } = mockReqResNext({ id: "admin-1", role: "ADMIN" });
    await requireVendorProfileOrAdmin()(request, response, next);
    expect(next).toHaveBeenCalledWith();
    expect(p.vendor.findUnique).not.toHaveBeenCalled();
  });
});

describe("requireApprovedSupplier — protected supplier actions only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    p.supplierAccount = { findUnique: vi.fn() };
  });

  it("E: a buyer with no SupplierAccount at all -> denied", async () => {
    p.supplierAccount.findUnique.mockResolvedValue(null);
    const { request, response, next } = mockReqResNext({ id: "buyer-1", role: "BUYER" });
    await requireApprovedSupplier()(request, response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it("a SupplierAccount that is only UNDER_REVIEW -> denied (approval, not mere application, is required)", async () => {
    p.supplierAccount.findUnique.mockResolvedValue({ supplierState: "UNDER_REVIEW" });
    const { request, response, next } = mockReqResNext({ id: "user-1", role: "BUYER" });
    await requireApprovedSupplier()(request, response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it("an APPROVED SupplierAccount -> allowed, regardless of role", async () => {
    p.supplierAccount.findUnique.mockResolvedValue({ supplierState: "APPROVED" });
    const { request, response, next } = mockReqResNext({ id: "user-1", role: "BUYER" });
    await requireApprovedSupplier()(request, response, next);
    expect(next).toHaveBeenCalledWith();
  });
});

// Figma S31/S32 correction — pausing/restricting must not cut a supplier off
// from a campaign they already accepted; only taking on NEW work stays
// strictly APPROVED-only. requireApprovedSupplier() itself is unchanged
// (still strict) — this is the separate, narrower gate for continuation
// routes only.
describe("requireApprovedSupplierForOwnCampaign — existing obligations survive pause/restriction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    p.supplierAccount = { findUnique: vi.fn() };
    p.communityCampaign = { findUnique: vi.fn() };
  });

  function mockReqWithParams(user: { id: string; role: "BUYER" | "VENDOR" | "ADMIN" }, params: Record<string, string> = {}) {
    const request: any = { user, params };
    const response: any = {};
    const next = vi.fn();
    return { request, response, next };
  }

  it("no SupplierAccount at all -> denied", async () => {
    p.supplierAccount.findUnique.mockResolvedValue(null);
    const { request, response, next } = mockReqWithParams({ id: "user-1", role: "BUYER" }, { id: "camp-1" });
    await requireApprovedSupplierForOwnCampaign()(request, response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(p.communityCampaign.findUnique).not.toHaveBeenCalled();
  });

  it("SUSPENDED -> denied even for their own campaign (suspension genuinely cuts a supplier off)", async () => {
    p.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "SUSPENDED" });
    const { request, response, next } = mockReqWithParams({ id: "user-1", role: "BUYER" }, { id: "camp-1" });
    await requireApprovedSupplierForOwnCampaign()(request, response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(p.communityCampaign.findUnique).not.toHaveBeenCalled();
  });

  it("APPROVED -> allowed without a campaign-ownership lookup (the strict, common case)", async () => {
    p.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "APPROVED" });
    const { request, response, next } = mockReqWithParams({ id: "user-1", role: "BUYER" }, { id: "camp-1" });
    await requireApprovedSupplierForOwnCampaign()(request, response, next);
    expect(next).toHaveBeenCalledWith();
    expect(p.communityCampaign.findUnique).not.toHaveBeenCalled();
  });

  it("PAUSED + campaign genuinely assigned to this account -> allowed (the exact bug fixed)", async () => {
    p.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "PAUSED" });
    p.communityCampaign.findUnique.mockResolvedValue({ supplierAccountId: "acct-1" });
    const { request, response, next } = mockReqWithParams({ id: "user-1", role: "BUYER" }, { id: "camp-1" });
    await requireApprovedSupplierForOwnCampaign()(request, response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("RESTRICTED + campaign genuinely assigned to this account -> allowed", async () => {
    p.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "RESTRICTED" });
    p.communityCampaign.findUnique.mockResolvedValue({ supplierAccountId: "acct-1" });
    const { request, response, next } = mockReqWithParams({ id: "user-1", role: "BUYER" }, { id: "camp-1" });
    await requireApprovedSupplierForOwnCampaign()(request, response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("PAUSED + a DIFFERENT campaign not assigned to this account -> denied (never a blanket bypass)", async () => {
    p.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "PAUSED" });
    p.communityCampaign.findUnique.mockResolvedValue({ supplierAccountId: "some-other-account" });
    const { request, response, next } = mockReqWithParams({ id: "user-1", role: "BUYER" }, { id: "camp-99" });
    await requireApprovedSupplierForOwnCampaign()(request, response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it("PAUSED + no :id param (a self-scoped list route) -> allowed without a campaign lookup", async () => {
    p.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", supplierState: "PAUSED" });
    const { request, response, next } = mockReqWithParams({ id: "user-1", role: "BUYER" }, {});
    await requireApprovedSupplierForOwnCampaign()(request, response, next);
    expect(next).toHaveBeenCalledWith();
    expect(p.communityCampaign.findUnique).not.toHaveBeenCalled();
  });
});

// ─── 3. Role-trap regression #8: opening a store must never mutate
// User.role — the exact bug this workstream removes. ────────────────────

vi.mock("../modules/vendors/vendor-markets.service", () => ({
  resolveCurrencyForMarket: vi.fn().mockResolvedValue("GBP"),
  vendorMarketsService: { ensureInitialAssignment: vi.fn() },
}));

describe("vendorsService.createVendor — role-trap regression #8", () => {
  it("never touches User.role — a buyer who opens a store keeps role: BUYER", async () => {
    const userUpdateMany = vi.fn();
    p.vendor = { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null) };
    p.wallet = { upsert: vi.fn() };
    p.user = { updateMany: userUpdateMany };
    p.$transaction = vi.fn().mockImplementation(async (callback: any) => {
      const tx = {
        vendor: { create: vi.fn().mockResolvedValue({ id: "vendor-new", storeName: "Store", country: "United Kingdom", currency: "GBP" }) },
        wallet: { upsert: vi.fn() },
        user: { updateMany: userUpdateMany },
      };
      return callback(tx);
    });

    const { vendorsService } = await import("../modules/vendors/vendors.service");
    await vendorsService.createVendor("buyer-1", { storeName: "Store", country: "United Kingdom" });

    // The old code's `tx.user.updateMany({ where: { role: BUYER }, data: { role: VENDOR } })`
    // must be gone entirely — not called with any arguments.
    expect(userUpdateMany).not.toHaveBeenCalled();
  });
});

// ─── 4. Supplier Centre onboarding — A, B, C/D from the plan's test
// matrix: no Vendor required, and applying never creates one. ───────────

describe("supplierAccountService.applyAsSupplier — Vendor-independent onboarding (A, B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    p.supplierAccount = { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() };
    p.vendor = { findUnique: vi.fn(), create: vi.fn(), findFirst: vi.fn(), update: vi.fn() };
  });

  it("A: a fresh buyer with no Vendor can start Supplier Centre onboarding successfully", async () => {
    p.supplierAccount.upsert.mockResolvedValue({ id: "sa-1", userId: "buyer-1", supplierState: "UNDER_REVIEW", categories: [], coverageRegions: ["GB"] });
    const { supplierAccountService } = await import("../modules/community-buy/supplier-account.service");
    const result = await supplierAccountService.applyAsSupplier("buyer-1", { country: "GB" });
    expect(result.supplierState).toBe("UNDER_REVIEW");
    expect(p.supplierAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "buyer-1" } }));
  });

  it("B: applying as a supplier creates zero Vendor rows as a side effect", async () => {
    p.supplierAccount.upsert.mockResolvedValue({ id: "sa-1", userId: "buyer-1", supplierState: "UNDER_REVIEW", categories: [], coverageRegions: ["GB"] });
    const { supplierAccountService } = await import("../modules/community-buy/supplier-account.service");
    await supplierAccountService.applyAsSupplier("buyer-1", { country: "GB" });
    expect(p.vendor.create).not.toHaveBeenCalled();
    expect(p.vendor.findUnique).not.toHaveBeenCalled();
    expect(p.vendor.update).not.toHaveBeenCalled();
  });

  it("re-applying over an already-APPROVED account is a no-op, not a re-review", async () => {
    p.supplierAccount.findUnique.mockResolvedValue({ id: "sa-1", userId: "buyer-1", supplierState: "APPROVED" });
    const { supplierAccountService } = await import("../modules/community-buy/supplier-account.service");
    const result = await supplierAccountService.applyAsSupplier("buyer-1", { country: "GB" });
    expect(result.supplierState).toBe("APPROVED");
    expect(p.supplierAccount.upsert).not.toHaveBeenCalled();
  });

  it("getView returns a computed NOT_STARTED view without creating a row", async () => {
    p.supplierAccount.findUnique.mockResolvedValue(null);
    const { supplierAccountService } = await import("../modules/community-buy/supplier-account.service");
    const view = await supplierAccountService.getView("brand-new-user");
    expect(view.supplierState).toBe("NOT_STARTED");
    expect(p.supplierAccount.upsert).not.toHaveBeenCalled();
  });
});
