/**
 * Account deletion — GDPR Article 17 + Apple App Review Guideline 5.1.1(v)
 * ("account deletion must be real, not cosmetic"). Real assertions that
 * deletion actually stops recurring billing, closes a public storefront,
 * and detaches OAuth identities — not just a cosmetic name/email swap —
 * and that it's correctly blocked while real money is still in flight.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../lib/prisma", () => ({
  prisma: {
    order: { count: vi.fn() },
    vendor: { findUnique: vi.fn(), update: vi.fn() },
    payoutRequest: { count: vi.fn() },
    organiserProfile: { findUnique: vi.fn() },
    communityCampaign: { count: vi.fn() },
    campaignContribution: { count: vi.fn() },
    buyerPaymentMethod: { findMany: vi.fn(), deleteMany: vi.fn() },
    buyerSubscription: { updateMany: vi.fn() },
    oAuthIdentity: { deleteMany: vi.fn() },
    product: { updateMany: vi.fn() },
    user: { update: vi.fn() },
    notification: { deleteMany: vi.fn() },
    pushToken: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: { paymentMethods: { detach: vi.fn() } },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { deleteAccount } from "../modules/auth/gdpr.controller";

const m = vi.mocked(prisma, true);

function createMockReq(userId = "buyer-1"): Request {
  return { user: { id: userId, role: "BUYER", email: "real@example.com" } } as unknown as Request;
}

function createMockRes(): Response & { statusCode: number; data: unknown } {
  const res = {
    statusCode: 0,
    data: null as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(data: unknown) { res.data = data; return res; },
  };
  return res as unknown as Response & { statusCode: number; data: unknown };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.order.count.mockResolvedValue(0);
  m.vendor.findUnique.mockResolvedValue(null);
  m.organiserProfile.findUnique.mockResolvedValue(null);
  m.campaignContribution.count.mockResolvedValue(0);
  m.buyerPaymentMethod.findMany.mockResolvedValue([]);
  vi.mocked(stripe.paymentMethods.detach).mockResolvedValue({} as never);
  m.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const tx = {
      buyerSubscription: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      buyerPaymentMethod: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      oAuthIdentity: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      vendor: { update: vi.fn().mockResolvedValue({}) },
      product: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      user: { update: vi.fn().mockResolvedValue({}) },
      notification: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      pushToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    return cb(tx);
  });
});

describe("deleteAccount — real blocking checks (never a cosmetic no-op)", () => {
  it("blocks deletion when a real order is still in flight", async () => {
    m.order.count.mockResolvedValue(1);
    await expect(deleteAccount(createMockReq(), createMockRes())).rejects.toMatchObject({ statusCode: 400 });
    expect(m.$transaction).not.toHaveBeenCalled();
  });

  it("blocks deletion when a vendor has a pending payout", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" } as never);
    m.payoutRequest.count.mockResolvedValue(1);
    await expect(deleteAccount(createMockReq(), createMockRes())).rejects.toMatchObject({ statusCode: 400 });
    expect(m.$transaction).not.toHaveBeenCalled();
  });

  it("blocks deletion when the user organises a still-live Community Buy campaign", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({ id: "org-1" } as never);
    m.communityCampaign.count.mockResolvedValue(1);
    await expect(deleteAccount(createMockReq(), createMockRes())).rejects.toMatchObject({ statusCode: 400 });
    expect(m.$transaction).not.toHaveBeenCalled();
  });

  it("blocks deletion when the buyer has an unresolved Community Buy pledge — deleting the saved card would silently break the later charge", async () => {
    m.campaignContribution.count.mockResolvedValue(1);
    await expect(deleteAccount(createMockReq(), createMockRes())).rejects.toMatchObject({ statusCode: 400 });
    expect(m.campaignContribution.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: { in: ["PLEDGED", "PAYMENT_PROCESSING"] } }) }),
    );
    expect(m.$transaction).not.toHaveBeenCalled();
  });
});

describe("deleteAccount — real, non-cosmetic deletion", () => {
  it("cancels active Regular Delivery subscriptions before detaching the payment method that funds them", async () => {
    m.buyerPaymentMethod.findMany.mockResolvedValue([{ stripePaymentMethodId: "pm_real_1" }] as never);
    let subscriptionCancelArgs: unknown;
    let paymentMethodDeleteCalledAfterCancel = false;
    m.$transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        buyerSubscription: {
          updateMany: vi.fn().mockImplementation((args) => {
            subscriptionCancelArgs = args;
            return Promise.resolve({ count: 1 });
          }),
        },
        buyerPaymentMethod: {
          deleteMany: vi.fn().mockImplementation(() => {
            paymentMethodDeleteCalledAfterCancel = subscriptionCancelArgs !== undefined;
            return Promise.resolve({ count: 1 });
          }),
        },
        oAuthIdentity: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        vendor: { update: vi.fn() },
        product: { updateMany: vi.fn() },
        user: { update: vi.fn().mockResolvedValue({}) },
        notification: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        pushToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return cb(tx);
    });

    await deleteAccount(createMockReq(), createMockRes());

    expect(subscriptionCancelArgs).toEqual(
      expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }),
    );
    expect(paymentMethodDeleteCalledAfterCancel).toBe(true);
    // Real Stripe detach — not just a local row delete.
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith("pm_real_1");
  });

  it("suspends the vendor's public storefront and deactivates every product — a deleted vendor account can't stay discoverable", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1" } as never);
    m.payoutRequest.count.mockResolvedValue(0);
    const vendorUpdate = vi.fn().mockResolvedValue({});
    const productUpdateMany = vi.fn().mockResolvedValue({ count: 3 });
    m.$transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        buyerSubscription: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        buyerPaymentMethod: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        oAuthIdentity: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        vendor: { update: vendorUpdate },
        product: { updateMany: productUpdateMany },
        user: { update: vi.fn().mockResolvedValue({}) },
        notification: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        pushToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return cb(tx);
    });

    await deleteAccount(createMockReq(), createMockRes());

    expect(vendorUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "vendor-1" }, data: { isSuspended: true } }));
    expect(productUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ vendorId: "vendor-1", isActive: true }), data: { isActive: false } }),
    );
  });

  it("removes OAuth identity links so a later Sign in with Apple/Google can't silently reuse the anonymized account", async () => {
    const oauthDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    m.$transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        buyerSubscription: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        buyerPaymentMethod: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        oAuthIdentity: { deleteMany: oauthDeleteMany },
        vendor: { update: vi.fn() },
        product: { updateMany: vi.fn() },
        user: { update: vi.fn().mockResolvedValue({}) },
        notification: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        pushToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return cb(tx);
    });

    await deleteAccount(createMockReq("buyer-2"), createMockRes());

    expect(oauthDeleteMany).toHaveBeenCalledWith({ where: { userId: "buyer-2" } });
  });

  it("invalidates all sessions (tokenVersion bump) and anonymizes identifying fields", async () => {
    const userUpdate = vi.fn().mockResolvedValue({});
    m.$transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        buyerSubscription: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        buyerPaymentMethod: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        oAuthIdentity: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        vendor: { update: vi.fn() },
        product: { updateMany: vi.fn() },
        user: { update: userUpdate },
        notification: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        pushToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return cb(tx);
    });

    await deleteAccount(createMockReq("buyer-3"), createMockRes());

    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "buyer-3" },
        data: expect.objectContaining({ tokenVersion: { increment: 1 }, name: "Deleted User" }),
      }),
    );
  });

  it("a Stripe detach failure never blocks the deletion response — the account is already anonymized by then", async () => {
    m.buyerPaymentMethod.findMany.mockResolvedValue([{ stripePaymentMethodId: "pm_will_fail" }] as never);
    vi.mocked(stripe.paymentMethods.detach).mockRejectedValueOnce(new Error("Stripe unavailable"));

    const res = createMockRes();
    await deleteAccount(createMockReq(), res);

    expect(res.statusCode).toBe(200);
  });
});
