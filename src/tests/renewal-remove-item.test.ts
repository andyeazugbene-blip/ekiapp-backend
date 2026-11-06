import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  renewal: { findUnique: vi.fn(), update: vi.fn() },
  renewalItem: { delete: vi.fn() },
  subscriptionItem: { deleteMany: vi.fn() },
  priceChangeRequest: { update: vi.fn() },
  recordAudit: vi.fn(),
  send: vi.fn(),
  status: vi.fn(),
  setHeader: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    renewal: m.renewal,
    $transaction: (fn: (tx: unknown) => unknown) => fn({ renewal: m.renewal, renewalItem: m.renewalItem, subscriptionItem: m.subscriptionItem, priceChangeRequest: m.priceChangeRequest }),
  },
}));
vi.mock("../shared/utils/audit", () => ({ recordAudit: m.recordAudit, requireAuditReason: (reason: string) => reason }));

import { env } from "../config/env";
import { renewalsService } from "../modules/regular-deliveries/renewals.service";
import { getReceiptPage, receiptsService } from "../modules/public-site/receipts-page";

const CHANGED = { id: "item-1", productId: "yam", quantity: 2, previousUnitPrice: 1000, currentUnitPrice: 1200 };
const SAME = { id: "item-2", productId: "rice", quantity: 1, previousUnitPrice: 500, currentUnitPrice: 500 };
const ALSO_CHANGED = { id: "item-3", productId: "oil", quantity: 1, previousUnitPrice: 700, currentUnitPrice: 900 };

function givenRenewal(overrides: Record<string, unknown> = {}) {
  m.renewal.findUnique.mockResolvedValue({
    id: "renewal-1", subscriptionId: "sub-1", status: "AWAITING_PRICE_APPROVAL", priceChangeRequestId: "pcr-1", items: [CHANGED, SAME],
    subscription: { id: "sub-1", buyerId: "buyer", offer: { vendorId: "vendor" } }, ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.recordAudit.mockResolvedValue(undefined);
});

describe("S46: removing an item from a price change", () => {
  it("only the buyer can do it", async () => {
    givenRenewal();
    await expect(renewalsService.buyerRemoveItemFromRenewal("someone-else", "renewal-1", "yam")).rejects.toMatchObject({ statusCode: 404 });
    expect(m.renewalItem.delete).not.toHaveBeenCalled();
  });

  it("is refused unless the renewal is waiting on this decision", async () => {
    givenRenewal({ status: "READY_FOR_PAYMENT" });
    await expect(renewalsService.buyerRemoveItemFromRenewal("buyer", "renewal-1", "yam")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.renewalItem.delete).not.toHaveBeenCalled();
  });

  it("refuses an item that isn't in the renewal", async () => {
    givenRenewal();
    await expect(renewalsService.buyerRemoveItemFromRenewal("buyer", "renewal-1", "nope")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("won't empty the basket, because skipping is the honest choice", async () => {
    givenRenewal({ items: [CHANGED] });
    await expect(renewalsService.buyerRemoveItemFromRenewal("buyer", "renewal-1", "yam")).rejects.toMatchObject({ code: "LAST_ITEM_IN_RENEWAL" });
    expect(m.renewalItem.delete).not.toHaveBeenCalled();
  });

  it("lets payment go ahead once nothing else changed, at the lower total", async () => {
    givenRenewal();
    await renewalsService.buyerRemoveItemFromRenewal("buyer", "renewal-1", "yam");
    expect(m.renewalItem.delete).toHaveBeenCalledWith({ where: { id: "item-1" } });
    expect(m.subscriptionItem.deleteMany).toHaveBeenCalledWith({ where: { subscriptionId: "sub-1", productId: "yam" } });
    expect(m.renewal.update).toHaveBeenCalledWith({ where: { id: "renewal-1" }, data: { subtotalAmount: 500, status: "READY_FOR_PAYMENT" } });
    expect(m.priceChangeRequest.update.mock.calls[0][0].data).toMatchObject({ buyerDecision: "accepted" });
  });

  it("keeps waiting if another item's price still changed", async () => {
    givenRenewal({ items: [CHANGED, ALSO_CHANGED, SAME] });
    await renewalsService.buyerRemoveItemFromRenewal("buyer", "renewal-1", "yam");
    expect(m.renewal.update).toHaveBeenCalledWith({ where: { id: "renewal-1" }, data: { subtotalAmount: 1400 } });
    expect(m.priceChangeRequest.update).not.toHaveBeenCalled();
  });
});

const RECEIPT_RENEWAL = {
  id: "renewal-abc123", currency: "GBP", orderId: "order-1",
  subscription: { buyerId: "buyer", offer: { vendor: { storeName: "Queen <Foods>" } } },
  items: [{ quantity: 2, currentUnitPrice: 1000, product: { title: "Yam" } }],
  order: { orderNumber: "order-number-1", subtotalAmount: 1800, deliveryFeeAmount: 500, totalAmount: 2300, createdAt: new Date("2026-11-06T10:00:00Z"), payment: { status: "SUCCEEDED" } },
};

async function page(token: string) {
  m.status.mockReturnValue({ send: m.send });
  await getReceiptPage({ params: { token } } as never, { setHeader: m.setHeader, status: m.status } as never);
  return { code: m.status.mock.calls.at(-1)?.[0] as number, html: m.send.mock.calls.at(-1)?.[0] as string };
}
const sign = (subject = "buyer") => jwt.sign({ purpose: "receipt", kind: "renewal", id: "renewal-abc123" }, env.jwtSecret, { subject, expiresIn: "15m" });

describe("S57: renewal receipt", () => {
  it("only gives a link to the buyer, and only once there's an order", async () => {
    m.renewal.findUnique.mockResolvedValue(RECEIPT_RENEWAL);
    await expect(receiptsService.renewalLink("someone-else", "r")).rejects.toMatchObject({ statusCode: 404 });
    await expect(receiptsService.renewalLink("buyer", "r")).resolves.toMatchObject({ url: expect.stringContaining("/receipt/") });
    m.renewal.findUnique.mockResolvedValue({ ...RECEIPT_RENEWAL, orderId: null });
    await expect(receiptsService.renewalLink("buyer", "r")).rejects.toMatchObject({ code: "RECEIPT_NOT_AVAILABLE" });
  });

  it("shows the client's fields, with the discount worked out from the list price", async () => {
    m.renewal.findUnique.mockResolvedValue(RECEIPT_RENEWAL);
    const { code, html } = await page(sign());
    expect(code).toBe(200);
    for (const text of ["Regular Delivery receipt", "Queen &lt;Foods&gt;", "Order reference", "Renewal reference", "Yam x2", "Total paid", "£23.00", "£2.00"]) expect(html).toContain(text);
  });

  it("doesn't claim paid while the payment is unconfirmed", async () => {
    m.renewal.findUnique.mockResolvedValue({ ...RECEIPT_RENEWAL, order: { ...RECEIPT_RENEWAL.order, payment: { status: "PENDING" } } });
    const { html } = await page(sign());
    expect(html).not.toContain("Total paid");
    expect(html).toContain("Payment under review");
  });

  it("refuses someone else's link", async () => {
    m.renewal.findUnique.mockResolvedValue(RECEIPT_RENEWAL);
    const { code, html } = await page(sign("attacker"));
    expect(code).toBe(410);
    expect(html).not.toContain("Yam");
  });
});
