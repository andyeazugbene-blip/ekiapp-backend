/**
 * B15 seller-payment readiness gate (cart + checkout + feed), and handbook
 * 14.6 product unpublish/restore (required reason, vendor notified, audit,
 * completeness gate).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  vendorFindMany: vi.fn(),
  productFindUnique: vi.fn(),
  productUpdateMany: vi.fn(),
  userFindUnique: vi.fn(),
  cartFindUnique: vi.fn(),
  recordAudit: vi.fn(),
  enqueue: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findMany: m.vendorFindMany },
    product: { findUnique: m.productFindUnique, updateMany: m.productUpdateMany, findMany: vi.fn().mockResolvedValue([]), count: vi.fn() },
    user: { findUnique: m.userFindUnique },
    cart: { findUnique: m.cartFindUnique },
    deliveryZone: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("../lib/stripe", () => ({ stripe: { paymentIntents: { create: vi.fn() } } }));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/email", () => ({ sendEmail: m.sendEmail }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: m.enqueue, create: vi.fn() } }));
vi.mock("../modules/subscriptions/subscriptions.service", () => ({ subscriptionsService: {} }));
vi.mock("../modules/promos/promos.service", () => ({ promosService: {} }));
vi.mock("../shared/utils/audit", async () => {
  const actual = await vi.importActual<typeof import("../shared/utils/audit")>("../shared/utils/audit");
  return { ...actual, recordAudit: m.recordAudit };
});

import {
  assertVendorsPurchasable,
  assessSellerReadiness,
  isSellerReadinessGateEnabled,
  purchasableVendorWhere,
} from "../modules/products/seller-readiness";
import { paymentsService } from "../modules/payments/payments.service";
import { cartService } from "../modules/cart/cart.service";
import { adminProductsService } from "../modules/admin/admin-products.service";
import { adminUnpublishProduct, adminRestoreProduct } from "../modules/admin/admin-products.controller";

const READY = { verificationStatus: "VERIFIED", isSuspended: false, closedAt: null, stripeAccountId: "acct_1", stripeChargesEnabled: true };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SELLER_PAYMENT_READINESS_GATE = "true";
});
afterEach(() => {
  delete process.env.SELLER_PAYMENT_READINESS_GATE;
});

describe("assessSellerReadiness", () => {
  it("ready only when verified, active and Stripe charges enabled", () => {
    expect(assessSellerReadiness(READY).ready).toBe(true);
    expect(assessSellerReadiness({ ...READY, verificationStatus: "PENDING" }).reason).toBe("VENDOR_NOT_VERIFIED");
    expect(assessSellerReadiness({ ...READY, isSuspended: true }).reason).toBe("VENDOR_SUSPENDED");
    expect(assessSellerReadiness({ ...READY, closedAt: new Date() }).reason).toBe("VENDOR_CLOSED");
    expect(assessSellerReadiness({ ...READY, stripeChargesEnabled: false }).reason).toBe("SELLER_PAYMENTS_NOT_ENABLED");
  });

  it("no Stripe account: Paystack recipient makes it ready, otherwise not ready", () => {
    const noStripe = { ...READY, stripeAccountId: null, stripeChargesEnabled: false };
    expect(assessSellerReadiness({ ...noStripe, bankAccounts: [{ paystackRecipientCode: "RCP_1" }] }).ready).toBe(true);
    expect(assessSellerReadiness({ ...noStripe, bankAccounts: [{ paystackRecipientCode: null }] }).ready).toBe(false);
    expect(assessSellerReadiness(noStripe).ready).toBe(false);
  });

  it("feed where-clause requires verified, not suspended, not closed", () => {
    expect(purchasableVendorWhere()).toMatchObject({ verificationStatus: "VERIFIED", isSuspended: false, closedAt: null });
  });
});

describe("env flag SELLER_PAYMENT_READINESS_GATE", () => {
  it("defaults off under NODE_ENV=test, explicit on/off honoured", async () => {
    delete process.env.SELLER_PAYMENT_READINESS_GATE;
    expect(isSellerReadinessGateEnabled()).toBe(false);
    process.env.SELLER_PAYMENT_READINESS_GATE = "true";
    expect(isSellerReadinessGateEnabled()).toBe(true);
    process.env.SELLER_PAYMENT_READINESS_GATE = "off";
    expect(isSellerReadinessGateEnabled()).toBe(false);
    m.vendorFindMany.mockResolvedValue([{ id: "v1", ...READY, stripeChargesEnabled: false }]);
    await expect(assertVendorsPurchasable(["v1"])).resolves.toBeUndefined();
    expect(m.vendorFindMany).not.toHaveBeenCalled();
  });
});

describe("gate enforcement", () => {
  it("assertVendorsPurchasable throws SELLER_PAYMENT_NOT_READY with the blocked vendor", async () => {
    m.vendorFindMany.mockResolvedValue([{ id: "v1", ...READY, stripeChargesEnabled: false, bankAccounts: [] }]);
    await expect(assertVendorsPurchasable(["v1"])).rejects.toMatchObject({
      code: "SELLER_PAYMENT_NOT_READY",
      statusCode: 409,
      details: { blocked: [{ vendorId: "v1", reason: "SELLER_PAYMENTS_NOT_ENABLED" }] },
    });
  });

  it("checkout (createPaymentIntent) refuses a cart containing a not-ready seller", async () => {
    m.cartFindUnique.mockResolvedValue({
      id: "cart-1",
      buyerId: "buyer-1",
      items: [{ productId: "p1", quantity: 1, product: { vendorId: "v1", isActive: true, stock: 5, title: "Egusi", priceInCents: 500, currency: "EUR" } }],
    });
    m.vendorFindMany.mockResolvedValue([{ id: "v1", ...READY, verificationStatus: "PENDING", bankAccounts: [] }]);
    await expect(paymentsService.createPaymentIntent({ cartId: "cart-1", deliveryCountry: "ireland" }, "buyer-1")).rejects.toMatchObject({ code: "SELLER_PAYMENT_NOT_READY" });
  });

  it("cart add refuses a not-ready seller", async () => {
    const tx = {
      cart: { upsert: vi.fn().mockResolvedValue({ id: "cart-1", items: [] }), findUnique: vi.fn() },
      product: { findUnique: vi.fn().mockResolvedValue({ id: "p1", vendorId: "v1", isActive: true, stock: 5 }) },
      vendor: { findMany: m.vendorFindMany },
      cartItem: { create: vi.fn() },
    };
    const { prisma } = await import("../lib/prisma");
    (prisma as any).$transaction = async (fn: any) => fn(tx);
    m.vendorFindMany.mockResolvedValue([{ id: "v1", ...READY, isSuspended: true, bankAccounts: [] }]);
    await expect(cartService.addItem("buyer-1", { productId: "p1", quantity: 1 } as any)).rejects.toMatchObject({ code: "SELLER_PAYMENT_NOT_READY" });
    expect(tx.cartItem.create).not.toHaveBeenCalled();
  });
});

function fakeRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: any) => ((res.body = b), res);
  return res;
}
const baseProduct = {
  id: "prod-1", title: "Egusi", vendorId: "v1", isActive: true, images: ["a.jpg"], priceInCents: 500,
  adminUnpublishedAt: null, adminUnpublishedReason: null, vendor: { userId: "owner-1", storeName: "Shop" },
};

describe("admin unpublish / restore", () => {
  it("unpublish without a reason is rejected (400 REASON_REQUIRED) and changes nothing", async () => {
    const req: any = { params: { id: "prod-1" }, body: { reason: "no" }, query: {}, user: { id: "admin-1" } };
    await expect(adminUnpublishProduct(req, fakeRes())).rejects.toMatchObject({ code: "REASON_REQUIRED", statusCode: 400 });
    expect(m.productUpdateMany).not.toHaveBeenCalled();
    expect(m.recordAudit).not.toHaveBeenCalled();
  });

  it("unpublish keeps the record (isActive=false), audits before/after and notifies the vendor in-app + email", async () => {
    m.productFindUnique.mockResolvedValue(baseProduct);
    m.productUpdateMany.mockResolvedValue({ count: 1 });
    m.userFindUnique.mockResolvedValue({ email: "owner@x.test", name: "Owner" });
    vi.spyOn(adminProductsService, "getProduct").mockResolvedValue({ id: "prod-1" } as any);
    const req: any = { params: { id: "prod-1" }, body: { reason: "Counterfeit listing reported" }, query: {}, user: { id: "admin-1" } };
    const res = fakeRes();
    await adminUnpublishProduct(req, res);
    expect(m.productUpdateMany.mock.calls[0][0].data).toMatchObject({ isActive: false, adminUnpublishedReason: "Counterfeit listing reported", adminUnpublishedById: "admin-1" });
    expect(m.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "product.unpublish", entityId: "prod-1", reason: "Counterfeit listing reported",
      beforeState: expect.objectContaining({ isActive: true }), afterState: expect.objectContaining({ isActive: false }),
    }));
    expect(m.enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner-1", data: expect.objectContaining({ event: "product_unpublished" }) }));
    expect(m.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@x.test" }));
    expect(res.statusCode).toBe(200);
  });

  it("restore refuses an incomplete product (no image / zero price)", async () => {
    m.productFindUnique.mockResolvedValue({ ...baseProduct, isActive: false, images: [] });
    await expect(adminProductsService.restore("prod-1", "Fixed")).rejects.toMatchObject({ code: "PRODUCT_INCOMPLETE", statusCode: 409 });
    m.productFindUnique.mockResolvedValue({ ...baseProduct, isActive: false, priceInCents: 0 });
    await expect(adminProductsService.restore("prod-1", "Fixed")).rejects.toMatchObject({ code: "PRODUCT_INCOMPLETE" });
  });

  it("restore requires a reason, clears unpublish markers, notifies and audits", async () => {
    const noReason: any = { params: { id: "prod-1" }, body: {}, query: {}, user: { id: "admin-1" } };
    await expect(adminRestoreProduct(noReason, fakeRes())).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    m.productFindUnique.mockResolvedValue({ ...baseProduct, isActive: false, adminUnpublishedAt: new Date(), adminUnpublishedReason: "x" });
    m.productUpdateMany.mockResolvedValue({ count: 1 });
    m.userFindUnique.mockResolvedValue({ email: "owner@x.test", name: "Owner" });
    vi.spyOn(adminProductsService, "getProduct").mockResolvedValue({ id: "prod-1" } as any);
    const req: any = { params: { id: "prod-1" }, body: { reason: "Issue resolved by vendor" }, query: {}, user: { id: "admin-1" } };
    await adminRestoreProduct(req, fakeRes());
    expect(m.productUpdateMany.mock.calls[0][0].data).toMatchObject({ isActive: true, adminUnpublishedAt: null, adminUnpublishedReason: null });
    expect(m.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "product.restore" }));
    expect(m.enqueue).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ event: "product_restored" }) }));
  });
});
