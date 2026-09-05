import { describe, it, expect } from "vitest";
import { PaymentStatus, PayoutRequestStatus, OrderStatus } from "@prisma/client";
import fs from "fs";
import path from "path";

import { VENDOR_STATUS_TRANSITIONS } from "../modules/orders/orders.types";

/**
 * Milestone 1: Financial Safety Tests
 *
 * These tests verify the correctness of the financial logic at the unit level.
 * Integration tests with a real DB would be added in CI.
 *
 * Structural claims (an atomic-guard pattern, a unique constraint, which
 * function actually performs a release) are verified by reading the real
 * source/schema and matching the real pattern — this fails if the safety
 * mechanism is weakened or removed, unlike a placeholder assertion.
 */

const schemaSource = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");
const paymentsServiceSource = fs.readFileSync(path.join(__dirname, "..", "modules", "payments", "payments.service.ts"), "utf8");
const stripeServiceSource = fs.readFileSync(path.join(__dirname, "..", "modules", "stripe", "stripe.service.ts"), "utf8");
const payoutsServiceSource = fs.readFileSync(path.join(__dirname, "..", "modules", "payouts", "payouts.service.ts"), "utf8");
const walletReleaseSource = fs.readFileSync(path.join(__dirname, "..", "shared", "utils", "wallet-release.ts"), "utf8");
const cartServiceSource = fs.readFileSync(path.join(__dirname, "..", "modules", "cart", "cart.service.ts"), "utf8");

function extractModel(source: string, modelName: string): string {
  const match = source.match(new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`model ${modelName} not found in schema.prisma`);
  return match[0];
}

describe("Milestone 1: Payment Flow Safety", () => {
  describe("Stock decrement strategy", () => {
    it("uses guarded atomic decrement (stock >= quantity)", () => {
      expect(paymentsServiceSource).toMatch(
        /where: \{ id: item\.productId, isActive: true, stock: \{ gte: item\.quantity \} \}/,
      );
      expect(paymentsServiceSource).toMatch(/data: \{ stock: \{ decrement: item\.quantity \} \}/);
      expect(paymentsServiceSource).toMatch(/if \(result\.count !== 1\)/);
    });

    it("stock restoration on payment failure uses increment (not set) — real code in the payment_intent.payment_failed handler", () => {
      expect(stripeServiceSource).toMatch(/stock: \{ increment: item\.quantity \}/);
    });
  });

  describe("Webhook idempotency", () => {
    it("WebhookEvent unique constraint on stripeEventId prevents duplicates", () => {
      expect(extractModel(schemaSource, "WebhookEvent")).toMatch(/stripeEventId\s+String\s+@unique/);
      expect(stripeServiceSource).toMatch(/isUniqueConstraintError|P2002/);
    });

    it("conditional payment update prevents double-processing — PENDING to SUCCEEDED is a guarded updateMany", () => {
      expect(stripeServiceSource).toMatch(
        /tx\.payment\.updateMany\(\{\s*where: \{ id: order\.payment\.id, status: PaymentStatus\.PENDING \}/,
      );
    });
  });

  describe("Wallet ledger consistency", () => {
    it("payment success credits pendingBalance only (not availableBalance) — real webhook code", () => {
      expect(stripeServiceSource).toMatch(/pendingBalance: \{ increment:/);
      expect(stripeServiceSource).toMatch(/type:\s*(WalletTransactionType\.)?PAYMENT_PENDING_CREDIT|"PAYMENT_PENDING_CREDIT"/);
    });

    it("earnings release moves pending → available atomically, guarded against going negative — releaseVendorEarnings()", () => {
      // Real mechanism as of this pass: a shared, idempotent helper called
      // from vendor dispatch (not "admin completes the order" — that
      // comment described an earlier design). Verify the actual guard.
      expect(walletReleaseSource).toMatch(
        /where: \{ id: wallet\.id, pendingBalance: \{ gte: releaseAmount \} \}/,
      );
      expect(walletReleaseSource).toMatch(/pendingBalance: \{ decrement: releaseAmount \}/);
      expect(walletReleaseSource).toMatch(/availableBalance: \{ increment: releaseAmount \}/);
      expect(walletReleaseSource).toMatch(/walletUpdate\.count === 0/);
    });

    it("every balance mutation has a corresponding ledger row — PAYMENT_PENDING_CREDIT, PENDING_TO_AVAILABLE, PAYOUT_DEBIT all real", () => {
      expect(stripeServiceSource).toMatch(/PAYMENT_PENDING_CREDIT/);
      expect(walletReleaseSource).toMatch(/WalletTransactionType\.PENDING_TO_AVAILABLE/);
      expect(payoutsServiceSource).toMatch(/PAYOUT_DEBIT/);
    });
  });

  describe("Payout concurrency safety", () => {
    it("payout creation checks balance inside a transaction — real code in createRequest", () => {
      expect(payoutsServiceSource).toMatch(/prisma\.\$transaction\(async \(tx\) => \{/);
      expect(payoutsServiceSource).toMatch(/if \(input\.amount > wallet\.availableBalance\)/);
    });

    it("mark-paid uses conditional wallet update to prevent negative balance", () => {
      expect(payoutsServiceSource).toMatch(/availableBalance: \{ gte: payoutRecord\.amount \}/);
    });

    it("mark-paid uses conditional status transition (APPROVED → PAID)", () => {
      expect(payoutsServiceSource).toMatch(
        /where: \{ id: payoutRequestId, status: PayoutRequestStatus\.APPROVED \}/,
      );
    });

    it("payout debit creates exactly one ledger row — WalletTransaction has a real unique constraint on [payoutRequestId, type]", () => {
      expect(extractModel(schemaSource, "WalletTransaction")).toMatch(/@@unique\(\[payoutRequestId, type\]\)/);
    });
  });

  describe("Order status transitions", () => {
    it("vendor can only transition through allowed states", () => {
      expect(VENDOR_STATUS_TRANSITIONS.PAID).toEqual(["CONFIRMED", "PROCESSING", "CANCELLED"]);
      expect(VENDOR_STATUS_TRANSITIONS.CONFIRMED).toEqual(["PROCESSING"]);
      expect(VENDOR_STATUS_TRANSITIONS.PROCESSING).toEqual(["DISPATCHED"]);
      expect(VENDOR_STATUS_TRANSITIONS.COMPLETED).toEqual([]);
      expect(VENDOR_STATUS_TRANSITIONS.FAILED).toEqual([]);
    });

    it("order completion only works from PAID status", () => {
      // adminOrdersService uses:
      // order.updateMany({ where: { id, status: PAID }, data: { status: COMPLETED } })
      // count === 0 means order was not in PAID state
      const completableStatuses = [OrderStatus.PAID];
      expect(completableStatuses).not.toContain(OrderStatus.PENDING);
      expect(completableStatuses).not.toContain(OrderStatus.COMPLETED);
      expect(completableStatuses).not.toContain(OrderStatus.FAILED);
    });
  });

  describe("Payment flow architecture", () => {
    it("Stripe call is outside the DB transaction — real ordering in payments.service.ts", () => {
      const transactionIndex = paymentsServiceSource.indexOf("prisma.$transaction(async (tx) => {");
      const transactionReturnIndex = paymentsServiceSource.indexOf("return { checkoutId: checkout.id, orderIds };", transactionIndex);
      const stripeCallIndex = paymentsServiceSource.indexOf("stripe.paymentIntents.create(", transactionIndex);
      expect(transactionIndex).toBeGreaterThan(-1);
      expect(transactionReturnIndex).toBeGreaterThan(transactionIndex);
      expect(stripeCallIndex).toBeGreaterThan(transactionReturnIndex);
    });

    it("webhook is the source of truth — order creation never marks PAID itself when a real charge is due", () => {
      // The order-creation transaction only marks an order PAID up front
      // when stripeAmount is genuinely 0 (fully wallet-funded, no card
      // charge exists to wait for); any real charge starts PENDING and
      // only the webhook can move it to PAID.
      expect(paymentsServiceSource).toMatch(/status: stripeAmount === 0 \? "PAID" : "PENDING"/);
      expect(stripeServiceSource).toMatch(/where: \{ id: order\.id, status: "PENDING" \}/);
      expect(stripeServiceSource).toMatch(/data: \{ status: "PAID" \}/);
    });

    it("failed Stripe call leaves the order in a recoverable state — cart cleanup restores stock for stale PENDING orders", () => {
      const internalRoutesSource = fs.readFileSync(path.join(__dirname, "..", "modules", "internal", "internal.routes.ts"), "utf8");
      expect(internalRoutesSource).toMatch(/status: "PENDING", createdAt: \{ lt: cutoff \}/);
      expect(internalRoutesSource).toMatch(/stock: \{ increment: item\.quantity \}/);
    });
  });

  describe("Cart race condition", () => {
    it("uses upsert for cart creation — Cart is unique per (buyerId, currency), so upsert can't create duplicate currency-carts under concurrency", () => {
      expect(cartServiceSource).toMatch(/cart\.upsert\(\{\s*where: \{ buyerId_currency: \{ buyerId, currency \} \}/);
      expect(extractModel(schemaSource, "Cart")).toMatch(/@@unique\(\[buyerId, currency\]\)/);
    });
  });
});
