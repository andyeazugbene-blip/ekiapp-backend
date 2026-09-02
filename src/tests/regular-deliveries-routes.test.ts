/**
 * Controller/HTTP-level tests for the Regular Deliveries routes.
 *
 * This module previously shipped with a real bug that only a real HTTP
 * request could catch: requireIdParam() called itself instead of reading
 * request.params.id, so EVERY :id route (pause/resume/cancel/skip/
 * stock-confirmation/price-change/retry-payment/offer update/publish...)
 * would have recursed until a stack overflow in production. The service
 * layer's own unit tests never exercise the controller, so they never
 * caught it. These tests go through the real Express router.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const mockCreateOffer = vi.fn();
const mockListForVendor = vi.fn();
const mockUpdateOffer = vi.fn();
const mockPublishOffer = vi.fn();
const mockUnpublishOffer = vi.fn();
const mockGetPublicOffer = vi.fn();
const mockPauseRenewals = vi.fn();
const mockResumeRenewals = vi.fn();

vi.mock("../modules/regular-deliveries/subscription-offers.service", () => ({
  subscriptionOffersService: {
    create: (...a: unknown[]) => mockCreateOffer(...a),
    listForVendor: (...a: unknown[]) => mockListForVendor(...a),
    update: (...a: unknown[]) => mockUpdateOffer(...a),
    publish: (...a: unknown[]) => mockPublishOffer(...a),
    unpublish: (...a: unknown[]) => mockUnpublishOffer(...a),
    getPublic: (...a: unknown[]) => mockGetPublicOffer(...a),
    pauseRenewals: (...a: unknown[]) => mockPauseRenewals(...a),
    resumeRenewals: (...a: unknown[]) => mockResumeRenewals(...a),
  },
}));

const mockCreateSub = vi.fn();
const mockListForBuyer = vi.fn();
const mockGetSub = vi.fn();
const mockUpdateItems = vi.fn();
const mockPause = vi.fn();
const mockResume = vi.fn();
const mockCancel = vi.fn();
const mockSkipNext = vi.fn();
const mockGetReorderSuggestions = vi.fn();

vi.mock("../modules/regular-deliveries/buyer-subscriptions.service", () => ({
  buyerSubscriptionsService: {
    create: (...a: unknown[]) => mockCreateSub(...a),
    listForBuyer: (...a: unknown[]) => mockListForBuyer(...a),
    getReorderSuggestions: (...a: unknown[]) => mockGetReorderSuggestions(...a),
    get: (...a: unknown[]) => mockGetSub(...a),
    updateItems: (...a: unknown[]) => mockUpdateItems(...a),
    pause: (...a: unknown[]) => mockPause(...a),
    resume: (...a: unknown[]) => mockResume(...a),
    cancel: (...a: unknown[]) => mockCancel(...a),
    skipNext: (...a: unknown[]) => mockSkipNext(...a),
  },
}));

const mockCreateSetupIntent = vi.fn();
const mockConfirmSetupIntent = vi.fn();
const mockListPaymentMethods = vi.fn();
const mockRemovePaymentMethod = vi.fn();

vi.mock("../modules/regular-deliveries/payment-methods.service", () => ({
  buyerPaymentMethodsService: {
    createSetupIntent: (...a: unknown[]) => mockCreateSetupIntent(...a),
    confirmSetupIntent: (...a: unknown[]) => mockConfirmSetupIntent(...a),
    list: (...a: unknown[]) => mockListPaymentMethods(...a),
    remove: (...a: unknown[]) => mockRemovePaymentMethod(...a),
  },
}));

const mockConfirmStock = vi.fn();
const mockBuyerDecidePriceChange = vi.fn();
const mockRetryPayment = vi.fn();

vi.mock("../modules/regular-deliveries/renewals.service", () => ({
  renewalsService: {
    confirmStock: (...a: unknown[]) => mockConfirmStock(...a),
    buyerDecidePriceChange: (...a: unknown[]) => mockBuyerDecidePriceChange(...a),
    retryPayment: (...a: unknown[]) => mockRetryPayment(...a),
  },
}));

const mockVendorFindUnique = vi.fn();
const mockOfferFindMany = vi.fn();
const mockSubscriptionFindMany = vi.fn();
const mockSubscriptionFindUnique = vi.fn();
const mockSubscriptionCount = vi.fn();
const mockRenewalFindMany = vi.fn();
const mockAddressFindUnique = vi.fn();
const mockPaymentMethodFindUnique = vi.fn();

vi.mock("../lib/prisma", async () => {
  const actual = await vi.importActual<typeof import("../lib/prisma")>("../lib/prisma");
  return {
    prisma: new Proxy(actual.prisma, {
      get(target, prop) {
        if (prop === "vendor") return { findUnique: (...a: unknown[]) => mockVendorFindUnique(...a) };
        if (prop === "subscriptionOffer") return { findMany: (...a: unknown[]) => mockOfferFindMany(...a) };
        if (prop === "buyerSubscription") {
          return {
            findMany: (...a: unknown[]) => mockSubscriptionFindMany(...a),
            findUnique: (...a: unknown[]) => mockSubscriptionFindUnique(...a),
            count: (...a: unknown[]) => mockSubscriptionCount(...a),
          };
        }
        if (prop === "renewal") return { findMany: (...a: unknown[]) => mockRenewalFindMany(...a) };
        return (target as any)[prop];
      },
    }),
  };
});

vi.mock("../middlewares/authenticate", async () => {
  const actual = await vi.importActual<typeof import("../middlewares/authenticate")>(
    "../middlewares/authenticate",
  );
  const { AppError } = await import("../shared/errors/app-error");
  return {
    ...actual,
    authenticate(request: any, _res: any, next: any) {
      const header = request.headers.authorization as string | undefined;
      if (!header || !header.startsWith("Bearer ")) {
        next(new AppError("Missing or invalid Authorization header", 401));
        return;
      }
      try {
        const token = header.slice(7);
        const payload = jwt.verify(token, "test-secret-key-for-testing-only") as {
          sub: string;
          role: "BUYER" | "VENDOR" | "ADMIN";
          email: string;
        };
        request.user = { id: payload.sub, role: payload.role, email: payload.email };
        next();
      } catch {
        next(new AppError("Invalid token", 401));
      }
    },
  };
});

import request from "supertest";
import type { Express } from "express";
import { generateTestToken } from "./helpers";

let app: Express;

beforeAll(async () => {
  const mod = await import("../app");
  app = mod.app;
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockVendorFindUnique.mockResolvedValue({ id: "vendor-db-1" });
  mockOfferFindMany.mockResolvedValue([{ id: "offer-1" }]);
  mockSubscriptionFindMany.mockResolvedValue([]);
  mockRenewalFindMany.mockResolvedValue([]);
  mockCreateOffer.mockResolvedValue({ id: "offer-1", title: "Test Box" });
  mockGetPublicOffer.mockResolvedValue({ id: "offer-1", isActive: true });
  mockUpdateOffer.mockResolvedValue({ id: "offer-1", title: "Updated" });
  mockPublishOffer.mockResolvedValue({ id: "offer-1", isActive: true });
  mockUnpublishOffer.mockResolvedValue({ id: "offer-1", isActive: false });
  mockCreateSub.mockResolvedValue({ id: "sub-1", status: "ACTIVE" });
  mockGetSub.mockResolvedValue({ id: "sub-1", buyerId: "buyer-1" });
  mockPause.mockResolvedValue({ id: "sub-1", status: "PAUSED" });
  mockResume.mockResolvedValue({ id: "sub-1", status: "ACTIVE" });
  mockCancel.mockResolvedValue({ id: "sub-1", status: "CANCELLED" });
  mockSkipNext.mockResolvedValue({ id: "sub-1" });
  mockUpdateItems.mockResolvedValue({ id: "sub-1" });
  mockConfirmStock.mockResolvedValue({ id: "renewal-1", status: "READY_FOR_PAYMENT" });
  mockBuyerDecidePriceChange.mockResolvedValue({ id: "renewal-1", status: "READY_FOR_PAYMENT" });
  mockRetryPayment.mockResolvedValue({ id: "renewal-1" });
  mockCreateSetupIntent.mockResolvedValue({ clientSecret: "seti_test_secret", customerId: "cus_1" });
  mockConfirmSetupIntent.mockResolvedValue({ id: "pm-1" });
  mockListPaymentMethods.mockResolvedValue([]);
});

const vendorToken = () => generateTestToken({ id: "vendor-user-1", role: "VENDOR", email: "v@x.com" });
const buyerToken = () => generateTestToken({ id: "buyer-1", role: "BUYER", email: "b@x.com" });

describe("Vendor subscription-offer routes", () => {
  it("POST /api/vendor/subscription-offers — 401 without token", async () => {
    const res = await request(app).post("/api/vendor/subscription-offers").send({});
    expect(res.status).toBe(401);
  });

  it("POST /api/vendor/subscription-offers — 201, resolves vendor from user, not trusting a client-supplied vendorId", async () => {
    const res = await request(app)
      .post("/api/vendor/subscription-offers")
      .set("Authorization", `Bearer ${vendorToken()}`)
      .send({ title: "Test Box", productIds: ["p1"], frequencies: ["WEEKLY"] });
    expect(res.status).toBe(201);
    expect(mockCreateOffer).toHaveBeenCalledWith("vendor-db-1", expect.objectContaining({ title: "Test Box" }));
  });

  it("PATCH /api/subscription-offers/:id — reads id from the URL correctly (regression guard for the requireIdParam recursion bug)", async () => {
    const res = await request(app)
      .patch("/api/subscription-offers/offer-42")
      .set("Authorization", `Bearer ${vendorToken()}`)
      .send({ title: "New title" });
    expect(res.status).toBe(200);
    expect(mockUpdateOffer).toHaveBeenCalledWith("vendor-db-1", "offer-42", expect.objectContaining({ title: "New title" }));
  });

  it("POST /api/subscription-offers/:id/publish — reads id from the URL, requires vendor auth", async () => {
    const unauth = await request(app).post("/api/subscription-offers/offer-42/publish");
    expect(unauth.status).toBe(401);

    const res = await request(app).post("/api/subscription-offers/offer-42/publish").set("Authorization", `Bearer ${vendorToken()}`);
    expect(res.status).toBe(200);
    expect(mockPublishOffer).toHaveBeenCalledWith("vendor-db-1", "offer-42");
  });

  it("GET /api/subscription-offers/:id — public, no auth required", async () => {
    const res = await request(app).get("/api/subscription-offers/offer-42");
    expect(res.status).toBe(200);
    expect(mockGetPublicOffer).toHaveBeenCalledWith("offer-42");
  });

  it("POST /api/subscription-offers/:id/pause-renewals — reads id from the URL, requires vendor auth", async () => {
    const unauth = await request(app).post("/api/subscription-offers/offer-42/pause-renewals");
    expect(unauth.status).toBe(401);

    const res = await request(app).post("/api/subscription-offers/offer-42/pause-renewals").set("Authorization", `Bearer ${vendorToken()}`);
    expect(res.status).toBe(200);
    expect(mockPauseRenewals).toHaveBeenCalledWith("vendor-db-1", "offer-42");
  });

  it("POST /api/subscription-offers/:id/resume-renewals — reads id from the URL", async () => {
    const res = await request(app).post("/api/subscription-offers/offer-42/resume-renewals").set("Authorization", `Bearer ${vendorToken()}`);
    expect(res.status).toBe(200);
    expect(mockResumeRenewals).toHaveBeenCalledWith("vendor-db-1", "offer-42");
  });
});

describe("Vendor subscriber detail and insights routes", () => {
  it("GET /api/vendor/subscribers/:id — 401 without token, 404 when the subscription belongs to another vendor's offer", async () => {
    const unauth = await request(app).get("/api/vendor/subscribers/sub-1");
    expect(unauth.status).toBe(401);

    mockSubscriptionFindUnique.mockResolvedValue({ id: "sub-1", offer: { vendorId: "some-other-vendor" } } as never);
    const res = await request(app).get("/api/vendor/subscribers/sub-1").set("Authorization", `Bearer ${vendorToken()}`);
    expect(res.status).toBe(404);
  });

  it("GET /api/vendor/subscribers/:id — 200 when the subscription belongs to this vendor", async () => {
    mockSubscriptionFindUnique.mockResolvedValue({ id: "sub-1", offer: { vendorId: "vendor-db-1" }, renewals: [] } as never);
    const res = await request(app).get("/api/vendor/subscribers/sub-1").set("Authorization", `Bearer ${vendorToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.subscription.id).toBe("sub-1");
  });

  it("GET /api/vendor/insights — 401 without token, 200 for a vendor with real aggregated counts", async () => {
    const unauth = await request(app).get("/api/vendor/insights");
    expect(unauth.status).toBe(401);

    mockSubscriptionCount.mockResolvedValue(0);
    mockRenewalFindMany.mockResolvedValue([]);
    const res = await request(app).get("/api/vendor/insights").set("Authorization", `Bearer ${vendorToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        activeSubscribers: 0,
        pausedSubscribers: 0,
        cancelledLast30Days: 0,
        paidRenewalsLast30Days: 0,
        revenueLast30Days: [],
        upcomingRenewalsNext7Days: 0,
      }),
    );
  });
});

describe("Buyer subscription routes", () => {
  it("POST /api/buyer/subscriptions — 401 without token", async () => {
    const res = await request(app).post("/api/buyer/subscriptions").send({});
    expect(res.status).toBe(401);
  });

  it("POST /api/buyer/subscriptions — 201 for an authenticated buyer", async () => {
    const res = await request(app)
      .post("/api/buyer/subscriptions")
      .set("Authorization", `Bearer ${buyerToken()}`)
      .send({ offerId: "offer-1", frequency: "WEEKLY", deliveryAddressId: "addr-1", paymentMethodId: "pm-1", items: [{ productId: "p1", quantity: 1 }] });
    expect(res.status).toBe(201);
    expect(mockCreateSub).toHaveBeenCalledWith("buyer-1", expect.any(Object));
  });

  it.each([
    ["pause", "/api/buyer/subscriptions/sub-9/pause", mockPause],
    ["resume", "/api/buyer/subscriptions/sub-9/resume", mockResume],
    ["cancel", "/api/buyer/subscriptions/sub-9/cancel", mockCancel],
    ["skip-next", "/api/buyer/subscriptions/sub-9/skip-next", mockSkipNext],
  ])("POST %s — resolves the :id from the URL correctly", async (_label, path, mockFn) => {
    const res = await request(app).post(path).set("Authorization", `Bearer ${buyerToken()}`).send({});
    expect(res.status).toBe(200);
    expect(mockFn.mock.calls[0][0]).toBe("buyer-1");
    expect(mockFn.mock.calls[0][1]).toBe("sub-9");
  });

  it("GET /api/buyer/subscriptions/reorder-suggestions — 401 without token, 200 for a buyer, and is NOT swallowed by the /:id route", async () => {
    const unauth = await request(app).get("/api/buyer/subscriptions/reorder-suggestions");
    expect(unauth.status).toBe(401);

    mockGetReorderSuggestions.mockResolvedValue([{ product: { id: "p1" }, offer: { id: "offer-1" }, orderCount: 3 }]);
    const res = await request(app).get("/api/buyer/subscriptions/reorder-suggestions").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(200);
    expect(mockGetReorderSuggestions).toHaveBeenCalledWith("buyer-1");
    expect(mockGetSub).not.toHaveBeenCalled();
    expect(res.body.items).toHaveLength(1);
  });

  it("GET /api/buyer/subscriptions/:id — 200, id correctly parsed", async () => {
    const res = await request(app).get("/api/buyer/subscriptions/sub-9").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(200);
    expect(mockGetSub).toHaveBeenCalledWith("buyer-1", "sub-9");
  });

  it("PATCH /api/buyer/subscriptions/:id — 400 when items is missing", async () => {
    const res = await request(app).patch("/api/buyer/subscriptions/sub-9").set("Authorization", `Bearer ${buyerToken()}`).send({});
    expect(res.status).toBe(400);
    expect(mockUpdateItems).not.toHaveBeenCalled();
  });
});

describe("Renewal action routes", () => {
  it("POST /api/renewals/:id/stock-confirmation — 401 without token, 403 for a buyer token, 200 for vendor", async () => {
    const noAuth = await request(app).post("/api/renewals/renewal-5/stock-confirmation");
    expect(noAuth.status).toBe(401);

    const wrongRole = await request(app).post("/api/renewals/renewal-5/stock-confirmation").set("Authorization", `Bearer ${buyerToken()}`);
    expect(wrongRole.status).toBe(403);

    const ok = await request(app).post("/api/renewals/renewal-5/stock-confirmation").set("Authorization", `Bearer ${vendorToken()}`);
    expect(ok.status).toBe(200);
    expect(mockConfirmStock).toHaveBeenCalledWith("vendor-user-1", "renewal-5");
  });

  it("POST /api/renewals/:id/price-change — 400 for an invalid decision value", async () => {
    const res = await request(app)
      .post("/api/renewals/renewal-5/price-change")
      .set("Authorization", `Bearer ${buyerToken()}`)
      .send({ decision: "maybe" });
    expect(res.status).toBe(400);
    expect(mockBuyerDecidePriceChange).not.toHaveBeenCalled();
  });

  it("POST /api/renewals/:id/price-change — 200 for a valid decision, id parsed correctly", async () => {
    const res = await request(app)
      .post("/api/renewals/renewal-5/price-change")
      .set("Authorization", `Bearer ${buyerToken()}`)
      .send({ decision: "accepted" });
    expect(res.status).toBe(200);
    expect(mockBuyerDecidePriceChange).toHaveBeenCalledWith("buyer-1", "renewal-5", "accepted");
  });

  it("POST /api/renewals/:id/retry-payment — id parsed correctly", async () => {
    const res = await request(app).post("/api/renewals/renewal-5/retry-payment").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(200);
    expect(mockRetryPayment).toHaveBeenCalledWith("buyer-1", "renewal-5");
  });
});

describe("Buyer payment method routes", () => {
  it("DELETE /api/buyer/payment-methods/:id — 204, id parsed correctly", async () => {
    const res = await request(app).delete("/api/buyer/payment-methods/pm-7").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(204);
    expect(mockRemovePaymentMethod).toHaveBeenCalledWith("buyer-1", "pm-7");
  });

  it("POST /api/buyer/payment-methods/setup-intent — 401 without token", async () => {
    const res = await request(app).post("/api/buyer/payment-methods/setup-intent");
    expect(res.status).toBe(401);
  });
});
