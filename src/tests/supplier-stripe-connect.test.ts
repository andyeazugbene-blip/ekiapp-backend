import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    supplierAccount: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: {
    accounts: { create: vi.fn(), retrieve: vi.fn() },
    accountLinks: { create: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { supplierStripeConnectService } from "../modules/community-buy/supplier-stripe-connect.service";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("supplierStripeConnectService — Workstream 3 (no-Vendor SupplierAccount path, mirrors vendors/stripe-connect.service.ts)", () => {
  it("onboard() 403s when no SupplierAccount exists at all — never falls back to a Vendor lookup (test K)", async () => {
    m.supplierAccount.findUnique.mockResolvedValue(null as never);
    await expect(supplierStripeConnectService.onboard("user-1")).rejects.toMatchObject({ statusCode: 403 });
    expect(m.vendor).toBeUndefined();
  });

  it("onboard() creates a new Express account (once) and returns an onboarding link (test A)", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({
      id: "acct-1", userId: "user-1", providerConnectedAccountId: null, user: { name: "Ada Supplier", email: "ada@example.com" },
    } as never);
    vi.mocked(stripe.accounts.create).mockResolvedValue({ id: "acct_new_1" } as never);
    vi.mocked(stripe.accountLinks.create).mockResolvedValue({ url: "https://connect.stripe.com/setup/acct_new_1" } as never);

    const result = await supplierStripeConnectService.onboard("user-1");

    expect(stripe.accounts.create).toHaveBeenCalledWith(expect.objectContaining({
      type: "express",
      email: "ada@example.com",
      metadata: { supplierAccountId: "acct-1", userId: "user-1" },
    }));
    expect(m.supplierAccount.update).toHaveBeenCalledWith({ where: { id: "acct-1" }, data: { providerConnectedAccountId: "acct_new_1" } });
    expect(result.onboardingUrl).toBe("https://connect.stripe.com/setup/acct_new_1");
  });

  it("onboard() reuses an existing Stripe account instead of creating a second one", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({
      id: "acct-1", userId: "user-1", providerConnectedAccountId: "acct_existing", user: { name: "Ada Supplier", email: "ada@example.com" },
    } as never);
    vi.mocked(stripe.accountLinks.create).mockResolvedValue({ url: "https://connect.stripe.com/setup/acct_existing" } as never);

    await supplierStripeConnectService.onboard("user-1");

    expect(stripe.accounts.create).not.toHaveBeenCalled();
    expect(stripe.accountLinks.create).toHaveBeenCalledWith(expect.objectContaining({ account: "acct_existing" }));
  });

  it("refresh() 400s when onboard() was never called", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-1", providerConnectedAccountId: null } as never);
    await expect(supplierStripeConnectService.refresh("user-1")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("getStatus() re-syncs live from Stripe and persists the result", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({
      id: "acct-1", providerConnectedAccountId: "acct_1", chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false,
    } as never);
    vi.mocked(stripe.accounts.retrieve).mockResolvedValue({ charges_enabled: true, payouts_enabled: true, details_submitted: true } as never);

    const result = await supplierStripeConnectService.getStatus("user-1");

    expect(m.supplierAccount.update).toHaveBeenCalledWith({
      where: { id: "acct-1" },
      data: { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
    });
    expect(result).toEqual({ providerConnectedAccountId: "acct_1", chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
  });

  it("getStatus() falls back to the last-known DB values if the Stripe retrieve call fails", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({
      id: "acct-1", providerConnectedAccountId: "acct_1", chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true,
    } as never);
    vi.mocked(stripe.accounts.retrieve).mockRejectedValue(new Error("network error"));

    const result = await supplierStripeConnectService.getStatus("user-1");

    expect(result).toEqual({ providerConnectedAccountId: "acct_1", chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true });
    expect(m.supplierAccount.update).not.toHaveBeenCalled();
  });
});
