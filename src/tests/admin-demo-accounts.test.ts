/**
 * Demo/marketing buyer account provisioning: mark isTest + credit a wallet
 * balance, so a real checkout goes through the EXISTING "fully paid by
 * wallet" branch — no new code in the Stripe/payment pipeline at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  userCreate: vi.fn(),
  buyerWalletUpsert: vi.fn(),
  buyerWalletCreate: vi.fn(),
  buyerWalletTransactionCreate: vi.fn(),
  vendorFindUnique: vi.fn(),
  vendorCreate: vi.fn(),
  deliveryZoneCreate: vi.fn(),
  supplierAccountCreate: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: m.userFindUnique, update: m.userUpdate, create: m.userCreate },
    buyerWallet: { upsert: m.buyerWalletUpsert, create: m.buyerWalletCreate },
    buyerWalletTransaction: { create: m.buyerWalletTransactionCreate },
    vendor: { findUnique: m.vendorFindUnique, create: m.vendorCreate },
    deliveryZone: { create: m.deliveryZoneCreate },
    supplierAccount: { create: m.supplierAccountCreate },
    $transaction: (fn: any) =>
      fn({
        user: { update: m.userUpdate, create: m.userCreate },
        buyerWallet: { upsert: m.buyerWalletUpsert, create: m.buyerWalletCreate },
        buyerWalletTransaction: { create: m.buyerWalletTransactionCreate },
        vendor: { create: m.vendorCreate },
        deliveryZone: { create: m.deliveryZoneCreate },
        supplierAccount: { create: m.supplierAccountCreate },
      }),
  },
}));

import { adminDemoAccountsService } from "../modules/admin/admin-demo-accounts.service";

beforeEach(() => {
  vi.clearAllMocks();
  m.userFindUnique.mockResolvedValue({ id: "buyer-1", role: "BUYER", isTest: false, email: "demo@test.local" });
  m.userUpdate.mockResolvedValue({});
  m.buyerWalletUpsert.mockResolvedValue({ id: "w1", balance: 500000, currency: "EUR" });
  m.buyerWalletCreate.mockResolvedValue({ id: "w1", balance: 500000, currency: "EUR" });
  m.buyerWalletTransactionCreate.mockResolvedValue({});
  m.userCreate.mockResolvedValue({ id: "new-buyer-1" });
  m.vendorFindUnique.mockResolvedValue(null); // slug is free
  m.vendorCreate.mockResolvedValue({ id: "demo-vendor-1", storeName: "Demo Store", storeSlug: "demo-store" });
  m.deliveryZoneCreate.mockResolvedValue({});
  m.supplierAccountCreate.mockResolvedValue({ id: "demo-supplier-1" });
});

describe("adminDemoAccountsService.provision", () => {
  it("marks the user isTest and credits a wallet with the default amount when none given", async () => {
    const result = await adminDemoAccountsService.provision("buyer-1", { reason: "Marketing demo account" });

    expect(m.userUpdate).toHaveBeenCalledWith({ where: { id: "buyer-1" }, data: { isTest: true } });
    expect(m.buyerWalletUpsert.mock.calls[0][0].create).toMatchObject({ buyerId: "buyer-1", balance: 500000 });
    expect(m.buyerWalletTransactionCreate.mock.calls[0][0].data).toMatchObject({ type: "TOP_UP", amount: 500000 });
    expect(result).toEqual({ userId: "buyer-1", isTest: true, walletBalanceMinor: 500000, currency: "EUR" });
  });

  it("increments an existing wallet rather than overwriting it", async () => {
    await adminDemoAccountsService.provision("buyer-1", { reason: "Top up for a demo video", creditMinor: 100000 });
    expect(m.buyerWalletUpsert.mock.calls[0][0].update).toEqual({ balance: { increment: 100000 } });
  });

  it("refuses a non-buyer account", async () => {
    m.userFindUnique.mockResolvedValue({ id: "vendor-1", role: "VENDOR", isTest: false });
    await expect(adminDemoAccountsService.provision("vendor-1", { reason: "test" })).rejects.toMatchObject({ statusCode: 409 });
    expect(m.userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a credit amount above the cap", async () => {
    await expect(adminDemoAccountsService.provision("buyer-1", { reason: "test", creditMinor: 2_000_000 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses a non-positive credit amount", async () => {
    await expect(adminDemoAccountsService.provision("buyer-1", { reason: "test", creditMinor: 0 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("404s on a user that doesn't exist", async () => {
    m.userFindUnique.mockResolvedValue(null);
    await expect(adminDemoAccountsService.provision("ghost", { reason: "test" })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("adminDemoAccountsService.createAndProvision", () => {
  beforeEach(() => {
    m.userFindUnique.mockResolvedValue(null); // no existing account by that email
  });

  it("creates a verified, isTest buyer and credits a wallet", async () => {
    const result = await adminDemoAccountsService.createAndProvision({
      email: "demo-client@example.com",
      password: "DemoPass123!",
      name: "Client Demo",
      reason: "Client marketing demo",
    });

    expect(m.userCreate.mock.calls[0][0].data).toMatchObject({
      email: "demo-client@example.com",
      role: "BUYER",
      isTest: true,
    });
    expect(m.userCreate.mock.calls[0][0].data.emailVerifiedAt).toBeInstanceOf(Date);
    expect(m.userCreate.mock.calls[0][0].data.password).not.toBe("DemoPass123!"); // hashed, not plaintext
    expect(m.buyerWalletCreate.mock.calls[0][0].data).toMatchObject({ buyerId: "new-buyer-1", balance: 500000 });
    expect(result).toMatchObject({ userId: "new-buyer-1", email: "demo-client@example.com", isTest: true, walletBalanceMinor: 500000 });
  });

  it("refuses an email that's already registered", async () => {
    m.userFindUnique.mockResolvedValue({ id: "existing-1" });
    await expect(
      adminDemoAccountsService.createAndProvision({ email: "taken@example.com", password: "DemoPass123!", name: "x", reason: "test" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(m.userCreate).not.toHaveBeenCalled();
  });

  it("refuses a credit amount above the cap", async () => {
    await expect(
      adminDemoAccountsService.createAndProvision({ email: "x@example.com", password: "DemoPass123!", name: "x", reason: "test", creditMinor: 2_000_000 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("with a storeName, also creates a pre-verified vendor store and a delivery zone so an added product publishes immediately", async () => {
    const result = await adminDemoAccountsService.createAndProvision({
      email: "demo-seller@example.com",
      password: "DemoPass123!",
      name: "Client Demo",
      reason: "Client wants to demo adding foodstuff too",
      storeName: "Demo Store",
      country: "GB",
    });

    expect(m.vendorCreate.mock.calls[0][0].data).toMatchObject({
      userId: "new-buyer-1",
      storeName: "Demo Store",
      storeSlug: "demo-store",
      isTest: true,
      verificationStatus: "VERIFIED",
    });
    expect(m.deliveryZoneCreate.mock.calls[0][0].data).toMatchObject({ vendorId: "demo-vendor-1", isActive: true });
    expect(result.vendor).toEqual({ id: "demo-vendor-1", storeName: "Demo Store", storeSlug: "demo-store" });
  });

  it("without a storeName, creates no vendor at all — stays a plain buyer demo", async () => {
    const result = await adminDemoAccountsService.createAndProvision({
      email: "demo-buyer-only@example.com", password: "DemoPass123!", name: "x", reason: "test",
    });
    expect(m.vendorCreate).not.toHaveBeenCalled();
    expect(m.deliveryZoneCreate).not.toHaveBeenCalled();
    expect(result.vendor).toBeNull();
  });

  it("with supplier:true, also creates a pre-approved SupplierAccount with payout readiness already satisfied", async () => {
    const result = await adminDemoAccountsService.createAndProvision({
      email: "demo-supplier@example.com",
      password: "DemoPass123!",
      name: "Client Demo",
      reason: "Client wants to demo Community Buy supplier payouts too",
      country: "GB",
      supplier: true,
    });

    expect(m.supplierAccountCreate.mock.calls[0][0].data).toMatchObject({
      userId: "new-buyer-1",
      supplierState: "APPROVED",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      coverageRegions: ["GB"],
    });
    expect(result.supplierAccount).toEqual({ id: "demo-supplier-1" });
  });

  it("without supplier:true, creates no SupplierAccount at all", async () => {
    const result = await adminDemoAccountsService.createAndProvision({
      email: "demo-no-supplier@example.com", password: "DemoPass123!", name: "x", reason: "test",
    });
    expect(m.supplierAccountCreate).not.toHaveBeenCalled();
    expect(result.supplierAccount).toBeNull();
  });
});
