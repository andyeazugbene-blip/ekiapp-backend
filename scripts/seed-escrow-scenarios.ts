/**
 * Escrow Scenarios Seed Script
 * Creates realistic Paystack escrow test scenarios.
 * 
 * Scenarios:
 * 1. ESCROW_PENDING_PAYMENT - checkout started, no payment
 * 2. ESCROW_PAID_HELD - payment success, funds held
 * 3. ESCROW_VENDOR_ACCEPTED - vendor accepted order
 * 4. ESCROW_SHIPPED - vendor marked shipped
 * 5. ESCROW_BUYER_CONFIRMED - buyer confirmed delivery
 * 6. ESCROW_AUTO_RELEASE_READY - ready for auto-release
 * 7. ESCROW_DISPUTED - buyer opened dispute
 * 8. ESCROW_REFUNDED - admin resolved refund
 * 9. ESCROW_VENDOR_PAYOUT_READY - vendor has releasable balance
 * 
 * Usage:
 *   npm run seed:escrow
 */
import {
  PrismaClient,
  OrderStatus,
  PaymentStatus,
  EscrowType,
  PaystackTxStatus,
  DisputeStatus,
  WalletTransactionType,
} from "@prisma/client";
import * as bcrypt from "bcryptjs";
import "dotenv/config";

const prisma = new PrismaClient();

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const PREFIX = process.env.QA_SEED_PREFIX || "SEED_QA_";
const ALLOW_PROVIDER_CALLS = process.env.QA_ALLOW_PROVIDER_CALLS === "true";

// ─── HELPERS ────────────────────────────────────────────────────────────────

function log(section: string, message: string) {
  console.log(`  [${section}] ${message}`);
}

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

async function applyEscrowWalletState(params: {
  vendorId: string;
  orderId: string;
  paymentId: string;
  status: OrderStatus;
  amount: number;
  currency: string;
}) {
  const wallet = await prisma.wallet.findUnique({
    where: { vendorId: params.vendorId },
    select: { id: true },
  });
  if (!wallet || params.amount <= 0) return;

  const createPendingCredit = async () => {
    await prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        vendorId: params.vendorId,
        orderId: params.orderId,
        paymentId: params.paymentId,
        type: WalletTransactionType.PAYMENT_PENDING_CREDIT,
        amount: params.amount,
        currency: params.currency,
        description: `QA escrow seed pending credit for order ${params.orderId}`,
      },
    });

    await prisma.wallet.update({
      where: { id: wallet.id },
      data: { pendingBalance: { increment: params.amount } },
    });
  };

  if (
    params.status === OrderStatus.PAID ||
    params.status === OrderStatus.VENDOR_CONFIRMED ||
    params.status === OrderStatus.DISPATCHED ||
    params.status === OrderStatus.DELIVERED ||
    params.status === OrderStatus.DISPUTED
  ) {
    await createPendingCredit();
    return;
  }

  if (params.status === OrderStatus.REFUNDED) {
    await createPendingCredit();
    await prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        vendorId: params.vendorId,
        orderId: params.orderId,
        type: WalletTransactionType.ADJUSTMENT_DEBIT,
        amount: -params.amount,
        currency: params.currency,
        description: `QA escrow seed refund reversal for order ${params.orderId}`,
      },
    });
    await prisma.wallet.update({
      where: { id: wallet.id },
      data: { pendingBalance: { decrement: params.amount } },
    });
    return;
  }

  if (params.status === OrderStatus.COMPLETED) {
    await createPendingCredit();
    await prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        vendorId: params.vendorId,
        orderId: params.orderId,
        paymentId: params.paymentId,
        type: WalletTransactionType.PENDING_TO_AVAILABLE,
        amount: params.amount,
        currency: params.currency,
        description: `QA escrow seed release for order ${params.orderId}`,
      },
    });
    await prisma.wallet.update({
      where: { id: wallet.id },
      data: {
        pendingBalance: { decrement: params.amount },
        availableBalance: { increment: params.amount },
      },
    });
  }
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  ESCROW SCENARIOS SEED");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Prefix: ${PREFIX}`);
  console.log(`  Provider Calls: ${ALLOW_PROVIDER_CALLS ? "ENABLED" : "DISABLED"}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  const scenarios: any[] = [];

  // ─── SETUP: Get or create Nigerian vendor ──────────────────────────────

  console.log("── SETUP ──\n");

  const vendorEmail = `${PREFIX.toLowerCase()}escrow_vendor@example.com`;
  let vendorUser = await prisma.user.findUnique({ where: { email: vendorEmail } });

  if (!vendorUser) {
    vendorUser = await prisma.user.create({
      data: {
        email: vendorEmail,
        name: `${PREFIX}Escrow Vendor`,
        password: await hashPassword("SeedQA123!"),
        role: "VENDOR",
        country: "Nigeria",
        emailVerifiedAt: new Date(),
      },
    });
  }

  let vendor = await prisma.vendor.findUnique({ where: { userId: vendorUser.id } });

  if (!vendor) {
    vendor = await prisma.vendor.create({
      data: {
        userId: vendorUser.id,
        storeName: `${PREFIX}Escrow Store`,
        storeSlug: `${PREFIX.toLowerCase()}escrow-store-${Date.now()}`,
        country: "Nigeria",
        currency: "NGN",
        contactEmail: vendorEmail,
        verificationStatus: "VERIFIED",
      },
    });

    await prisma.wallet.create({
      data: {
        vendorId: vendor.id,
        currency: "NGN",
        pendingBalance: 0,
        availableBalance: 0,
      },
    });
  }

  log("SETUP", `Vendor: ${vendor.storeName} (${vendor.currency})`);

  // Get or create buyer
  const buyerEmail = `${PREFIX.toLowerCase()}escrow_buyer@example.com`;
  let buyer = await prisma.user.findUnique({ where: { email: buyerEmail } });

  if (!buyer) {
    buyer = await prisma.user.create({
      data: {
        email: buyerEmail,
        name: `${PREFIX}Escrow Buyer`,
        password: await hashPassword("SeedQA123!"),
        role: "BUYER",
        country: "Nigeria",
        emailVerifiedAt: new Date(),
      },
    });
  }

  log("SETUP", `Buyer: ${buyer.email}`);

  // Create test product
  const productTitle = `${PREFIX}Escrow Test Product`;
  let product = await prisma.product.findFirst({
    where: {
      vendorId: vendor.id,
      title: productTitle,
    },
  });

  if (!product) {
    product = await prisma.product.create({
      data: {
        vendorId: vendor.id,
        title: productTitle,
        description: "Test product for escrow scenarios",
        priceInCents: 10000, // 100 NGN
        currency: "NGN",
        stock: 100,
        category: "food",
        isActive: true,
      },
    });
  }

  log("SETUP", `Product: ${product.title} (NGN ${product.priceInCents / 100})`);

  // ─── SCENARIO 1: PENDING_PAYMENT ────────────────────────────────────────

  console.log("\n── SCENARIO 1: PENDING_PAYMENT ──\n");

  const order1 = await prisma.order.create({
    data: {
      buyerId: buyer.id,
      vendorId: vendor.id,
      status: OrderStatus.PENDING,
      escrowType: EscrowType.DOMESTIC_AFRICA,
      subtotalAmount: 10000,
      deliveryFeeAmount: 500,
      platformFeeAmount: 1000,
      vendorEarnings: 9000,
      totalAmount: 10500,
      currency: "NGN",
      items: {
        create: {
          productId: product.id,
          vendorId: vendor.id,
          quantity: 1,
          unitAmount: 10000,
          totalAmount: 10000,
          currency: "NGN",
          productTitle: product.title,
        },
      },
    },
  });

  scenarios.push({
    scenario: "ESCROW_PENDING_PAYMENT",
    orderId: order1.id,
    orderNumber: order1.orderNumber,
    status: order1.status,
    description: "Checkout started, no payment success yet",
  });

  log("SCENARIO 1", `Order ${order1.orderNumber} - PENDING`);

  // ─── SCENARIO 2: PAID_HELD ──────────────────────────────────────────────

  console.log("\n── SCENARIO 2: PAID_HELD ──\n");

  const order2 = await prisma.order.create({
    data: {
      buyerId: buyer.id,
      vendorId: vendor.id,
      status: OrderStatus.PAID,
      escrowType: EscrowType.DOMESTIC_AFRICA,
      subtotalAmount: 10000,
      deliveryFeeAmount: 500,
      platformFeeAmount: 1000,
      vendorEarnings: 9000,
      totalAmount: 10500,
      currency: "NGN",
      items: {
        create: {
          productId: product.id,
          vendorId: vendor.id,
          quantity: 1,
          unitAmount: 10000,
          totalAmount: 10000,
          currency: "NGN",
          productTitle: product.title,
        },
      },
    },
  });

  const payment2 = await prisma.payment.create({
    data: {
      orderId: order2.id,
      amount: 10500,
      platformFeeAmount: 1000,
      vendorEarningsAmount: 9000,
      currency: "NGN",
      status: PaymentStatus.SUCCEEDED,
      provider: "paystack",
      processedAt: new Date(),
    },
  });

  await prisma.paystackTransaction.create({
    data: {
      orderId: order2.id,
      reference: `seedqa_escrow_paid_${order2.id}`,
      amount: 10500,
      currency: "NGN",
      status: PaystackTxStatus.SUCCESS,
    },
  });

  await applyEscrowWalletState({
    vendorId: vendor.id,
    orderId: order2.id,
    paymentId: payment2.id,
    status: order2.status,
    amount: 9000,
    currency: "NGN",
  });

  scenarios.push({
    scenario: "ESCROW_PAID_HELD",
    orderId: order2.id,
    orderNumber: order2.orderNumber,
    status: order2.status,
    description: "Payment success, funds held in escrow",
  });

  log("SCENARIO 2", `Order ${order2.orderNumber} - PAID (escrow held)`);

  // ─── SCENARIO 3: VENDOR_ACCEPTED ────────────────────────────────────────

  console.log("\n── SCENARIO 3: VENDOR_ACCEPTED ──\n");

  const order3 = await prisma.order.create({
    data: {
      buyerId: buyer.id,
      vendorId: vendor.id,
      status: OrderStatus.VENDOR_CONFIRMED,
      escrowType: EscrowType.DOMESTIC_AFRICA,
      vendorConfirmedAt: new Date(),
      subtotalAmount: 10000,
      deliveryFeeAmount: 500,
      platformFeeAmount: 1000,
      vendorEarnings: 9000,
      totalAmount: 10500,
      currency: "NGN",
      items: {
        create: {
          productId: product.id,
          vendorId: vendor.id,
          quantity: 1,
          unitAmount: 10000,
          totalAmount: 10000,
          currency: "NGN",
          productTitle: product.title,
        },
      },
    },
  });

  const payment3 = await prisma.payment.create({
    data: {
      orderId: order3.id,
      amount: 10500,
      platformFeeAmount: 1000,
      vendorEarningsAmount: 9000,
      currency: "NGN",
      status: PaymentStatus.SUCCEEDED,
      provider: "paystack",
      processedAt: new Date(),
    },
  });

  await prisma.paystackTransaction.create({
    data: {
      orderId: order3.id,
      reference: `seedqa_escrow_accepted_${order3.id}`,
      amount: 10500,
      currency: "NGN",
      status: PaystackTxStatus.SUCCESS,
    },
  });

  await applyEscrowWalletState({
    vendorId: vendor.id,
    orderId: order3.id,
    paymentId: payment3.id,
    status: order3.status,
    amount: 9000,
    currency: "NGN",
  });

  scenarios.push({
    scenario: "ESCROW_VENDOR_ACCEPTED",
    orderId: order3.id,
    orderNumber: order3.orderNumber,
    status: order3.status,
    description: "Vendor accepted order",
  });

  log("SCENARIO 3", `Order ${order3.orderNumber} - VENDOR_CONFIRMED`);

  // ─── SCENARIO 4: SHIPPED ────────────────────────────────────────────────

  console.log("\n── SCENARIO 4: SHIPPED ──\n");

  const order4 = await prisma.order.create({
    data: {
      buyerId: buyer.id,
      vendorId: vendor.id,
      status: OrderStatus.DISPATCHED,
      escrowType: EscrowType.DOMESTIC_AFRICA,
      vendorConfirmedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      subtotalAmount: 10000,
      deliveryFeeAmount: 500,
      platformFeeAmount: 1000,
      vendorEarnings: 9000,
      totalAmount: 10500,
      currency: "NGN",
      items: {
        create: {
          productId: product.id,
          vendorId: vendor.id,
          quantity: 1,
          unitAmount: 10000,
          totalAmount: 10000,
          currency: "NGN",
          productTitle: product.title,
        },
      },
    },
  });

  const payment4 = await prisma.payment.create({
    data: {
      orderId: order4.id,
      amount: 10500,
      platformFeeAmount: 1000,
      vendorEarningsAmount: 9000,
      currency: "NGN",
      status: PaymentStatus.SUCCEEDED,
      provider: "paystack",
      processedAt: new Date(),
    },
  });

  await prisma.paystackTransaction.create({
    data: {
      orderId: order4.id,
      reference: `seedqa_escrow_shipped_${order4.id}`,
      amount: 10500,
      currency: "NGN",
      status: PaystackTxStatus.SUCCESS,
    },
  });

  await applyEscrowWalletState({
    vendorId: vendor.id,
    orderId: order4.id,
    paymentId: payment4.id,
    status: order4.status,
    amount: 9000,
    currency: "NGN",
  });

  scenarios.push({
    scenario: "ESCROW_SHIPPED",
    orderId: order4.id,
    orderNumber: order4.orderNumber,
    status: order4.status,
    description: "Vendor marked shipped",
  });

  log("SCENARIO 4", `Order ${order4.orderNumber} - DISPATCHED`);

  // ─── SCENARIO 5: BUYER_CONFIRMED ────────────────────────────────────────

  console.log("\n── SCENARIO 5: BUYER_CONFIRMED ──\n");

  const order5 = await prisma.order.create({
    data: {
      buyerId: buyer.id,
      vendorId: vendor.id,
      status: OrderStatus.DELIVERED,
      escrowType: EscrowType.DOMESTIC_AFRICA,
      vendorConfirmedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      deliveredAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
      subtotalAmount: 10000,
      deliveryFeeAmount: 500,
      platformFeeAmount: 1000,
      vendorEarnings: 9000,
      totalAmount: 10500,
      currency: "NGN",
      items: {
        create: {
          productId: product.id,
          vendorId: vendor.id,
          quantity: 1,
          unitAmount: 10000,
          totalAmount: 10000,
          currency: "NGN",
          productTitle: product.title,
        },
      },
    },
  });

  const payment5 = await prisma.payment.create({
    data: {
      orderId: order5.id,
      amount: 10500,
      platformFeeAmount: 1000,
      vendorEarningsAmount: 9000,
      currency: "NGN",
      status: PaymentStatus.SUCCEEDED,
      provider: "paystack",
      processedAt: new Date(),
    },
  });

  await prisma.paystackTransaction.create({
    data: {
      orderId: order5.id,
      reference: `seedqa_escrow_confirmed_${order5.id}`,
      amount: 10500,
      currency: "NGN",
      status: PaystackTxStatus.SUCCESS,
    },
  });

  await applyEscrowWalletState({
    vendorId: vendor.id,
    orderId: order5.id,
    paymentId: payment5.id,
    status: order5.status,
    amount: 9000,
    currency: "NGN",
  });

  scenarios.push({
    scenario: "ESCROW_BUYER_CONFIRMED",
    orderId: order5.id,
    orderNumber: order5.orderNumber,
    status: order5.status,
    description: "Buyer confirmed delivery, funds eligible for release",
  });

  log("SCENARIO 5", `Order ${order5.orderNumber} - DELIVERED (confirmed)`);

  // ─── SCENARIO 6: AUTO_RELEASE_READY ─────────────────────────────────────

  console.log("\n── SCENARIO 6: AUTO_RELEASE_READY ──\n");

  const autoReleaseHours = parseInt(process.env.ESCROW_AUTO_RELEASE_HOURS || "24");
  const oldDeliveryDate = new Date(Date.now() - (autoReleaseHours + 2) * 60 * 60 * 1000);

  const order6 = await prisma.order.create({
    data: {
      buyerId: buyer.id,
      vendorId: vendor.id,
      status: OrderStatus.DELIVERED,
      escrowType: EscrowType.DOMESTIC_AFRICA,
      vendorConfirmedAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
      deliveredAt: oldDeliveryDate,
      escrowExpiresAt: new Date(oldDeliveryDate.getTime() + autoReleaseHours * 60 * 60 * 1000),
      subtotalAmount: 10000,
      deliveryFeeAmount: 500,
      platformFeeAmount: 1000,
      vendorEarnings: 9000,
      totalAmount: 10500,
      currency: "NGN",
      items: {
        create: {
          productId: product.id,
          vendorId: vendor.id,
          quantity: 1,
          unitAmount: 10000,
          totalAmount: 10000,
          currency: "NGN",
          productTitle: product.title,
        },
      },
    },
  });

  const payment6 = await prisma.payment.create({
    data: {
      orderId: order6.id,
      amount: 10500,
      platformFeeAmount: 1000,
      vendorEarningsAmount: 9000,
      currency: "NGN",
      status: PaymentStatus.SUCCEEDED,
      provider: "paystack",
      processedAt: new Date(),
    },
  });

  await prisma.paystackTransaction.create({
    data: {
      orderId: order6.id,
      reference: `seedqa_escrow_autorelease_${order6.id}`,
      amount: 10500,
      currency: "NGN",
      status: PaystackTxStatus.SUCCESS,
    },
  });

  await applyEscrowWalletState({
    vendorId: vendor.id,
    orderId: order6.id,
    paymentId: payment6.id,
    status: order6.status,
    amount: 9000,
    currency: "NGN",
  });

  scenarios.push({
    scenario: "ESCROW_AUTO_RELEASE_READY",
    orderId: order6.id,
    orderNumber: order6.orderNumber,
    status: order6.status,
    description: `Delivered ${autoReleaseHours + 2}h ago, ready for auto-release`,
  });

  log("SCENARIO 6", `Order ${order6.orderNumber} - AUTO_RELEASE_READY`);

  // ─── SCENARIO 7: DISPUTED ───────────────────────────────────────────────

  console.log("\n── SCENARIO 7: DISPUTED ──\n");

  const order7 = await prisma.order.create({
    data: {
      buyerId: buyer.id,
      vendorId: vendor.id,
      status: OrderStatus.DISPUTED,
      escrowType: EscrowType.DOMESTIC_AFRICA,
      vendorConfirmedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      deliveredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      disputedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
      subtotalAmount: 10000,
      deliveryFeeAmount: 500,
      platformFeeAmount: 1000,
      vendorEarnings: 9000,
      totalAmount: 10500,
      currency: "NGN",
      items: {
        create: {
          productId: product.id,
          vendorId: vendor.id,
          quantity: 1,
          unitAmount: 10000,
          totalAmount: 10000,
          currency: "NGN",
          productTitle: product.title,
        },
      },
    },
  });

  const payment7 = await prisma.payment.create({
    data: {
      orderId: order7.id,
      amount: 10500,
      platformFeeAmount: 1000,
      vendorEarningsAmount: 9000,
      currency: "NGN",
      status: PaymentStatus.SUCCEEDED,
      provider: "paystack",
      processedAt: new Date(),
    },
  });

  await prisma.paystackTransaction.create({
    data: {
      orderId: order7.id,
      reference: `seedqa_escrow_disputed_${order7.id}`,
      amount: 10500,
      currency: "NGN",
      status: PaystackTxStatus.SUCCESS,
    },
  });

  await prisma.dispute.create({
    data: {
      orderId: order7.id,
      buyerId: buyer.id,
      vendorId: vendor.id,
      reason: `${PREFIX}Test dispute - product not as described`,
      status: DisputeStatus.OPEN,
    },
  });

  await applyEscrowWalletState({
    vendorId: vendor.id,
    orderId: order7.id,
    paymentId: payment7.id,
    status: order7.status,
    amount: 9000,
    currency: "NGN",
  });

  scenarios.push({
    scenario: "ESCROW_DISPUTED",
    orderId: order7.id,
    orderNumber: order7.orderNumber,
    status: order7.status,
    description: "Buyer opened dispute, funds frozen",
  });

  log("SCENARIO 7", `Order ${order7.orderNumber} - DISPUTED`);

  // ─── SCENARIO 8: REFUNDED ───────────────────────────────────────────────

  console.log("\n── SCENARIO 8: REFUNDED ──\n");

  const order8 = await prisma.order.create({
    data: {
      buyerId: buyer.id,
      vendorId: vendor.id,
      status: OrderStatus.REFUNDED,
      escrowType: EscrowType.DOMESTIC_AFRICA,
      vendorConfirmedAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
      disputedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      subtotalAmount: 10000,
      deliveryFeeAmount: 500,
      platformFeeAmount: 1000,
      vendorEarnings: 9000,
      totalAmount: 10500,
      currency: "NGN",
      items: {
        create: {
          productId: product.id,
          vendorId: vendor.id,
          quantity: 1,
          unitAmount: 10000,
          totalAmount: 10000,
          currency: "NGN",
          productTitle: product.title,
        },
      },
    },
  });

  const payment8 = await prisma.payment.create({
    data: {
      orderId: order8.id,
      amount: 10500,
      platformFeeAmount: 1000,
      vendorEarningsAmount: 9000,
      currency: "NGN",
      status: PaymentStatus.SUCCEEDED,
      provider: "paystack",
      processedAt: new Date(),
    },
  });

  await prisma.paystackTransaction.create({
    data: {
      orderId: order8.id,
      reference: `seedqa_escrow_refunded_${order8.id}`,
      amount: 10500,
      currency: "NGN",
      status: PaystackTxStatus.SUCCESS,
    },
  });

  await prisma.dispute.create({
    data: {
      orderId: order8.id,
      buyerId: buyer.id,
      vendorId: vendor.id,
      reason: `${PREFIX}Test dispute - resolved with refund`,
      status: DisputeStatus.RESOLVED_BUYER,
      resolution: "Full refund issued to buyer",
      refundAmount: 10500,
      resolvedAt: new Date(),
    },
  });

  await applyEscrowWalletState({
    vendorId: vendor.id,
    orderId: order8.id,
    paymentId: payment8.id,
    status: order8.status,
    amount: 9000,
    currency: "NGN",
  });

  scenarios.push({
    scenario: "ESCROW_REFUNDED",
    orderId: order8.id,
    orderNumber: order8.orderNumber,
    status: order8.status,
    description: "Admin resolved dispute with refund",
  });

  log("SCENARIO 8", `Order ${order8.orderNumber} - REFUNDED`);

  // ─── SCENARIO 9: VENDOR_PAYOUT_READY ────────────────────────────────────

  console.log("\n── SCENARIO 9: VENDOR_PAYOUT_READY ──\n");

  // Create completed order and move funds to available balance
  const order9 = await prisma.order.create({
    data: {
      buyerId: buyer.id,
      vendorId: vendor.id,
      status: OrderStatus.COMPLETED,
      escrowType: EscrowType.DOMESTIC_AFRICA,
      vendorConfirmedAt: new Date(Date.now() - 96 * 60 * 60 * 1000),
      deliveredAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
      autoReleasedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      subtotalAmount: 10000,
      deliveryFeeAmount: 500,
      platformFeeAmount: 1000,
      vendorEarnings: 9000,
      totalAmount: 10500,
      currency: "NGN",
      items: {
        create: {
          productId: product.id,
          vendorId: vendor.id,
          quantity: 1,
          unitAmount: 10000,
          totalAmount: 10000,
          currency: "NGN",
          productTitle: product.title,
        },
      },
    },
  });

  const payment9 = await prisma.payment.create({
    data: {
      orderId: order9.id,
      amount: 10500,
      platformFeeAmount: 1000,
      vendorEarningsAmount: 9000,
      currency: "NGN",
      status: PaymentStatus.SUCCEEDED,
      provider: "paystack",
      processedAt: new Date(),
    },
  });

  await prisma.paystackTransaction.create({
    data: {
      orderId: order9.id,
      reference: `seedqa_escrow_payout_${order9.id}`,
      amount: 10500,
      currency: "NGN",
      status: PaystackTxStatus.SUCCESS,
    },
  });

  await applyEscrowWalletState({
    vendorId: vendor.id,
    orderId: order9.id,
    paymentId: payment9.id,
    status: order9.status,
    amount: 9000,
    currency: "NGN",
  });

  scenarios.push({
    scenario: "ESCROW_VENDOR_PAYOUT_READY",
    orderId: order9.id,
    orderNumber: order9.orderNumber,
    status: order9.status,
    description: "Vendor has releasable balance for payout",
  });

  log("SCENARIO 9", `Order ${order9.orderNumber} - COMPLETED (payout ready)`);

  // ─── SAVE REPORT ────────────────────────────────────────────────────────

  console.log("\n── SAVING REPORT ──\n");

  const report = {
    timestamp: new Date().toISOString(),
    vendor: {
      id: vendor.id,
      email: vendorEmail,
      storeName: vendor.storeName,
      currency: vendor.currency,
    },
    buyer: {
      id: buyer.id,
      email: buyerEmail,
    },
    product: {
      id: product.id,
      title: product.title,
    },
    scenarios,
  };

  const fs = await import("fs/promises");
  await fs.writeFile("ESCROW_SEED_REPORT.md", `# Escrow Scenarios Report

**Generated:** ${new Date().toISOString()}

## Vendor
- **Email:** ${vendorEmail}
- **Store:** ${vendor.storeName}
- **Currency:** ${vendor.currency}

## Buyer
- **Email:** ${buyerEmail}

## Scenarios

${scenarios.map((s, i) => `### ${i + 1}. ${s.scenario}
- **Order:** ${s.orderNumber}
- **Status:** ${s.status}
- **Description:** ${s.description}
`).join("\n")}

## Testing

### API Endpoints to Test
\`\`\`bash
# Get vendor orders
GET /api/vendors/me/orders

# Get buyer orders
GET /api/orders

# Get order detail
GET /api/orders/{orderId}

# Admin disputes
GET /api/admin/disputes

# Escrow health check (if available)
GET /api/admin/escrow/health
\`\`\`

### Expected Behaviors
1. **PENDING_PAYMENT**: Should show as unpaid
2. **PAID_HELD**: Vendor pending balance should reflect escrow hold
3. **VENDOR_ACCEPTED**: Vendor confirmed timestamp should be set
4. **SHIPPED**: Should show tracking/dispatch info
5. **BUYER_CONFIRMED**: Should be eligible for release
6. **AUTO_RELEASE_READY**: Should be picked by auto-release job
7. **DISPUTED**: Should block auto-release, show in disputes list
8. **REFUNDED**: Should show refund record, buyer credited
9. **PAYOUT_READY**: Vendor available balance should allow payout

## Cleanup
\`\`\`bash
npm run cleanup:qa
\`\`\`
`);

  log("SAVE", "Report saved to ESCROW_SEED_REPORT.md");

  // ─── SUMMARY ────────────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  ESCROW SCENARIOS COMPLETE");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Scenarios created: ${scenarios.length}`);
  console.log(`  Vendor: ${vendor.storeName}`);
  console.log(`  Buyer: ${buyer.email}`);
  console.log("═══════════════════════════════════════════════════════════\n");
  console.log(`  ✅ Report: ESCROW_SEED_REPORT.md`);
  console.log(`  ✅ Cleanup: npm run cleanup:qa\n`);
}

main()
  .catch((e) => {
    console.error("FATAL ERROR:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
