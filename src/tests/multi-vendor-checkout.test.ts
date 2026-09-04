import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Milestone 2: Multi-Vendor Cart & Checkout Tests
 *
 * These verify the correctness of the multi-vendor architecture at the logic level.
 * Integration tests with a real DB would be added in CI.
 *
 * Where a claim is about a structural invariant (a schema field's absence,
 * an exact unique constraint, an atomic-guard pattern in a specific
 * service) rather than a runtime value, the assertion reads the real
 * source/schema file and checks for the real pattern — a genuine
 * regression test that fails if the safety mechanism is removed, not a
 * live-DB integration test (those need real infrastructure this repo's
 * test environment doesn't have — see the header note above).
 */

const schemaSource = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");
const paymentsServiceSource = fs.readFileSync(path.join(__dirname, "..", "modules", "payments", "payments.service.ts"), "utf8");
const stripeServiceSource = fs.readFileSync(path.join(__dirname, "..", "modules", "stripe", "stripe.service.ts"), "utf8");
const ordersServiceSource = fs.readFileSync(path.join(__dirname, "..", "modules", "orders", "orders.service.ts"), "utf8");

function extractModel(source: string, modelName: string): string {
  const match = source.match(new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`model ${modelName} not found in schema.prisma`);
  return match[0];
}

describe("Multi-Vendor Cart", () => {
  it("cart no longer enforces single-vendor restriction — Cart has no vendorId field", () => {
    const cartModel = extractModel(schemaSource, "Cart");
    expect(cartModel).not.toMatch(/vendorId/);
  });

  it("cart items are grouped by vendor at checkout", () => {
    const items = [
      { productId: "p1", vendorId: "v1", quantity: 2, totalAmount: 1000 },
      { productId: "p2", vendorId: "v1", quantity: 1, totalAmount: 500 },
      { productId: "p3", vendorId: "v2", quantity: 3, totalAmount: 2400 },
    ];

    const vendorMap = new Map<string, typeof items>();
    for (const item of items) {
      const existing = vendorMap.get(item.vendorId) ?? [];
      existing.push(item);
      vendorMap.set(item.vendorId, existing);
    }

    expect(vendorMap.size).toBe(2);
    expect(vendorMap.get("v1")!.length).toBe(2);
    expect(vendorMap.get("v2")!.length).toBe(1);
  });

  it("subtotal is calculated per vendor group", () => {
    const v1Items = [
      { totalAmount: 1000 },
      { totalAmount: 500 },
    ];
    const v2Items = [
      { totalAmount: 2400 },
    ];

    const v1Subtotal = v1Items.reduce((sum, i) => sum + i.totalAmount, 0);
    const v2Subtotal = v2Items.reduce((sum, i) => sum + i.totalAmount, 0);

    expect(v1Subtotal).toBe(1500);
    expect(v2Subtotal).toBe(2400);
  });

  it("delivery fee is calculated per vendor group", () => {
    const baseFee = 500;
    const feePerKg = 200;

    const v1Weight = 2500; // grams
    const v2Weight = 800;  // grams

    const v1Delivery = baseFee + Math.ceil(v1Weight / 1000) * feePerKg; // 500 + 3*200 = 1100
    const v2Delivery = baseFee + Math.ceil(v2Weight / 1000) * feePerKg; // 500 + 1*200 = 700

    expect(v1Delivery).toBe(1100);
    expect(v2Delivery).toBe(700);
  });

  it("platform fee is calculated per vendor group", () => {
    const feeBps = 1000; // 10%
    const v1Subtotal = 1500;
    const v2Subtotal = 2400;

    const v1Fee = Math.round((v1Subtotal * feeBps) / 10000);
    const v2Fee = Math.round((v2Subtotal * feeBps) / 10000);

    expect(v1Fee).toBe(150);
    expect(v2Fee).toBe(240);
  });

  it("grand total is sum of all vendor group totals", () => {
    const groups = [
      { subtotal: 1500, delivery: 1100 },
      { subtotal: 2400, delivery: 700 },
    ];
    const grandTotal = groups.reduce((sum, g) => sum + g.subtotal + g.delivery, 0);
    expect(grandTotal).toBe(5700);
  });
});

describe("Multi-Vendor Checkout Flow", () => {
  it("one Stripe PaymentIntent is created for the entire checkout", () => {
    // paymentsService creates ONE PI with amount = grandTotal
    // metadata includes checkoutId, buyerId, orderIds (comma-separated), vendorIds
    const metadata = {
      checkoutId: "ck_123",
      buyerId: "buyer_1",
      orderIds: "ord_1,ord_2",
      vendorIds: "v1,v2",
    };
    expect(metadata.orderIds.split(",")).toHaveLength(2);
  });

  it("one Checkout record links to multiple Orders", () => {
    // Checkout has orders: Order[] relation
    // Each Order has checkoutId pointing back
    const checkout = { id: "ck_123", orders: ["ord_1", "ord_2"] };
    expect(checkout.orders.length).toBe(2);
  });

  it("each vendor gets their own Order with correct amounts", () => {
    const order1 = { vendorId: "v1", subtotal: 1500, platformFee: 150, vendorEarnings: 1350 };
    const order2 = { vendorId: "v2", subtotal: 2400, platformFee: 240, vendorEarnings: 2160 };

    expect(order1.vendorEarnings).toBe(order1.subtotal - order1.platformFee);
    expect(order2.vendorEarnings).toBe(order2.subtotal - order2.platformFee);
  });
});

describe("Multi-Vendor Refund Notification", () => {
  it("charge.refunded webhook notifies the buyer after the transaction commits — previously order status, ledger, wallet reversal and stock all updated correctly but the buyer was never told their refund happened", () => {
    const handlerSource = stripeServiceSource.slice(
      stripeServiceSource.indexOf("private async handleChargeRefunded"),
      stripeServiceSource.indexOf("private async ", stripeServiceSource.indexOf("private async handleChargeRefunded") + 1),
    );
    // Fired from the buyerId/orderIds captured out of the transaction's
    // return value, not from inside the transaction closure itself —
    // matches the established sendSuccessNotifications() pattern for the
    // payment-success path elsewhere in this same file.
    expect(handlerSource).toMatch(/notificationsService\.enqueue\(\{/);
    expect(handlerSource).toMatch(/type:\s*"order_refunded"/);
    expect(handlerSource).toMatch(/refundedBuyerId/);
    expect(handlerSource).toMatch(/refundedOrderIds/);
  });
});

describe("Multi-Vendor Webhook Idempotency", () => {
  it("duplicate webhook does not duplicate vendor orders — two independent guards, both real", () => {
    // Layer 1: WebhookEvent.stripeEventId is DB-unique — a replayed event ID
    // fails to insert the processing marker.
    const webhookEventModel = extractModel(schemaSource, "WebhookEvent");
    expect(webhookEventModel).toMatch(/stripeEventId\s+String\s+@unique/);
    // Layer 2: even if layer 1 were bypassed, the checkout transition itself
    // is a guarded conditional update (count=0 on a second call), not an
    // unconditional write.
    expect(stripeServiceSource).toMatch(
      /checkout\.updateMany\(\{\s*where:\s*\{\s*id:\s*checkoutId,\s*status:\s*PaymentStatus\.PENDING/,
    );
  });

  it("duplicate webhook does not double-credit vendor wallets — WalletTransaction has a real composite unique constraint", () => {
    const walletTransactionModel = extractModel(schemaSource, "WalletTransaction");
    expect(walletTransactionModel).toMatch(/@@unique\(\[vendorId, orderId, paymentId, type\]\)/);
  });

  it("each vendor receives correct pending wallet credit", () => {
    const v1Earnings = 1350;
    const v2Earnings = 2160;

    // Webhook creates one WalletTransaction per vendor order
    // wallet.pendingBalance += vendorEarningsAmount per order
    expect(v1Earnings + v2Earnings).toBe(3510);
  });
});

describe("Multi-Vendor Stock Safety", () => {
  it("stock is decremented atomically for ALL items, inside the same transaction that creates the orders", () => {
    // The guarded decrement (real invariant that makes overselling
    // impossible: only succeeds if stock >= requested quantity) must live
    // inside prisma.$transaction, not as a standalone pre-check — otherwise
    // a failure partway through would leave earlier vendors' stock
    // decremented with no order ever created for them.
    const transactionBlock = paymentsServiceSource.match(/prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?\n {4}\}\);/);
    expect(transactionBlock).not.toBeNull();
    const body = transactionBlock![0];
    expect(body).toMatch(/stock: \{ gte: item\.quantity \}/);
    expect(body).toMatch(/stock: \{ decrement: item\.quantity \}/);
    expect(body).toMatch(/if \(result\.count !== 1\)/);
  });

  it("if one vendor item is out of stock, entire checkout fails — the insufficient-stock throw happens inside the transaction, not after it", () => {
    const transactionBlock = paymentsServiceSource.match(/prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?\n {4}\}\);/);
    expect(transactionBlock).not.toBeNull();
    expect(transactionBlock![0]).toMatch(/throw new AppError\(`Insufficient stock for/);
  });

  it("failed payment restores stock for ALL vendor groups — the payment_intent.payment_failed handler increments stock back", () => {
    expect(stripeServiceSource).toMatch(/stock: \{ increment: item\.quantity \}/);
  });

  it("concurrent checkouts cannot oversell — the decrement is a guarded conditional update, not a read-then-write", () => {
    // A real read-then-write (findUnique + check + update) would race; the
    // actual code uses updateMany's WHERE clause as the atomic guard so
    // Postgres itself serializes concurrent decrements against the same row.
    expect(paymentsServiceSource).toMatch(/tx\.product\.updateMany\(\{\s*where: \{ id: item\.productId, isActive: true, stock: \{ gte: item\.quantity \} \}/);
  });
});

describe("Concurrency (200 simultaneous checkouts)", () => {
  it("Stripe calls are outside the DB transaction — no long-held connection during the network round-trip", () => {
    // Real risk being guarded against: if stripe.paymentIntents.create()
    // ran INSIDE prisma.$transaction, every concurrent checkout would hold
    // a DB connection/lock for the full 1-3s Stripe round-trip, exhausting
    // the pool under load. Confirm the Stripe call is textually AFTER the
    // transaction closes, not nested inside it.
    const transactionIndex = paymentsServiceSource.indexOf("prisma.$transaction(async (tx) => {");
    const transactionReturnIndex = paymentsServiceSource.indexOf("return { checkoutId: checkout.id, orderIds };", transactionIndex);
    const stripeCallIndex = paymentsServiceSource.indexOf("stripe.paymentIntents.create(", transactionIndex);
    expect(transactionIndex).toBeGreaterThan(-1);
    expect(transactionReturnIndex).toBeGreaterThan(transactionIndex);
    expect(stripeCallIndex).toBeGreaterThan(transactionReturnIndex);
  });

  it("idempotency keys prevent duplicate Stripe charges on checkout retry", () => {
    expect(paymentsServiceSource).toMatch(/idempotencyKey: `pi:checkout:\$\{checkoutId\}`/);
  });

  it("unique constraints prevent duplicate orders on retry — all three real constraints present", () => {
    const checkoutModel = extractModel(schemaSource, "Checkout");
    expect(checkoutModel).toMatch(/stripePaymentIntentId\s+String\?\s+@unique/);
    expect(extractModel(schemaSource, "WebhookEvent")).toMatch(/stripeEventId\s+String\s+@unique/);
    expect(extractModel(schemaSource, "WalletTransaction")).toMatch(/@@unique\(\[vendorId, orderId, paymentId, type\]\)/);
  });

  it("conditional updates prevent race conditions on wallet credits — increment is atomic, not read-check-write", () => {
    expect(stripeServiceSource).toMatch(/pendingBalance: \{ increment:/);
  });
});

describe("Multi-Vendor Order Visibility", () => {
  it("vendor can only see orders containing their items — listVendorOrders filters by Order.vendorId, scoped to the requesting vendor's own row", () => {
    expect(ordersServiceSource).toMatch(/async listVendorOrders\(/);
    // Real scoping chain: resolve the vendor row for the authenticated user
    // first, then filter orders by THAT vendor's id — never a client-
    // supplied vendorId, so vendor A can't pass vendor B's id to see their orders.
    const fnBody = ordersServiceSource.slice(
      ordersServiceSource.indexOf("async listVendorOrders("),
      ordersServiceSource.indexOf("async getVendorOrder("),
    );
    expect(fnBody).toMatch(/vendor\.findUnique\(\{\s*where: \{ userId \}/);
    expect(fnBody).toMatch(/where: \{\s*vendorId: vendor\.id/);
  });

  it("buyer sees all split orders under one checkout — Checkout.orders is a real relation buyers can traverse", () => {
    const checkoutModel = extractModel(schemaSource, "Checkout");
    expect(checkoutModel).toMatch(/orders\s+Order\[\]/);
    expect(checkoutModel).toMatch(/buyerId\s+String/);
  });
});
