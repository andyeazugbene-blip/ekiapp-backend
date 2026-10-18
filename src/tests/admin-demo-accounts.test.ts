/**
 * Demo/marketing buyer account provisioning: mark isTest + credit a wallet
 * balance, so a real checkout goes through the EXISTING "fully paid by
 * wallet" branch — no new code in the Stripe/payment pipeline at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  buyerWalletUpsert: vi.fn(),
  buyerWalletTransactionCreate: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: m.userFindUnique, update: m.userUpdate },
    buyerWallet: { upsert: m.buyerWalletUpsert },
    buyerWalletTransaction: { create: m.buyerWalletTransactionCreate },
    $transaction: (fn: any) => fn({ user: { update: m.userUpdate }, buyerWallet: { upsert: m.buyerWalletUpsert }, buyerWalletTransaction: { create: m.buyerWalletTransactionCreate } }),
  },
}));

import { adminDemoAccountsService } from "../modules/admin/admin-demo-accounts.service";

beforeEach(() => {
  vi.clearAllMocks();
  m.userFindUnique.mockResolvedValue({ id: "buyer-1", role: "BUYER", isTest: false, email: "demo@test.local" });
  m.userUpdate.mockResolvedValue({});
  m.buyerWalletUpsert.mockResolvedValue({ id: "w1", balance: 500000, currency: "EUR" });
  m.buyerWalletTransactionCreate.mockResolvedValue({});
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
