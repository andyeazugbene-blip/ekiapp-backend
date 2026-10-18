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
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: m.userFindUnique, update: m.userUpdate, create: m.userCreate },
    buyerWallet: { upsert: m.buyerWalletUpsert, create: m.buyerWalletCreate },
    buyerWalletTransaction: { create: m.buyerWalletTransactionCreate },
    $transaction: (fn: any) =>
      fn({
        user: { update: m.userUpdate, create: m.userCreate },
        buyerWallet: { upsert: m.buyerWalletUpsert, create: m.buyerWalletCreate },
        buyerWalletTransaction: { create: m.buyerWalletTransactionCreate },
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
});
