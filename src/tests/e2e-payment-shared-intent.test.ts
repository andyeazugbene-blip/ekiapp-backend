/**
 * REAL database regression test: a multi-vendor checkout creates exactly
 * ONE Stripe PaymentIntent shared across every vendor's Order/Payment row
 * (see payments.service.ts createPaymentIntent). Payment.stripePaymentIntentId
 * used to carry a UNIQUE constraint left over from a pre-multi-vendor design
 * — the Stripe webhook's per-order update loop (stripe.service.ts
 * processPaymentSucceeded) would throw a P2002 unique-constraint violation
 * on the SECOND order of any real 2+-vendor Stripe checkout, rolling back
 * the whole transaction and leaving every vendor after the first stuck
 * PENDING despite the buyer having actually paid.
 *
 * This runs against the real database (not mocked Prisma) specifically
 * because a unique-constraint violation is a real DB-level behavior no
 * mock can meaningfully assert against.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TEST_BUYER_EMAIL = `e2e-shared-pi-buyer-${Date.now()}@test.eki`;
let buyerId: string;
const orderIds: string[] = [];

beforeAll(async () => {
  const buyer = await prisma.user.create({
    data: { email: TEST_BUYER_EMAIL, name: "E2E Shared PI Buyer", password: "unused", role: "BUYER" },
  });
  buyerId = buyer.id;
});

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.user.delete({ where: { id: buyerId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("Payment.stripePaymentIntentId shared across a multi-vendor checkout", () => {
  it("allows two different orders' payments to reference the SAME Stripe PaymentIntent without a unique-constraint violation", async () => {
    const sharedPaymentIntentId = `pi_e2e_shared_${Date.now()}`;

    const orderA = await prisma.order.create({ data: { buyerId, totalAmount: 1000, currency: "eur" } });
    const orderB = await prisma.order.create({ data: { buyerId, totalAmount: 2000, currency: "usd" } });
    orderIds.push(orderA.id, orderB.id);

    // This is exactly the write pattern stripe.service.ts's
    // processPaymentSucceeded performs once per order in the checkout —
    // before the fix, the second of these would throw P2002.
    await prisma.payment.create({
      data: { orderId: orderA.id, stripePaymentIntentId: sharedPaymentIntentId, amount: 1000, platformFeeAmount: 0, vendorEarningsAmount: 1000, currency: "eur", status: "SUCCEEDED" },
    });

    await expect(
      prisma.payment.create({
        data: { orderId: orderB.id, stripePaymentIntentId: sharedPaymentIntentId, amount: 2000, platformFeeAmount: 0, vendorEarningsAmount: 2000, currency: "usd", status: "SUCCEEDED" },
      }),
    ).resolves.toMatchObject({ stripePaymentIntentId: sharedPaymentIntentId });

    const payments = await prisma.payment.findMany({ where: { stripePaymentIntentId: sharedPaymentIntentId } });
    expect(payments).toHaveLength(2);
  });
});
