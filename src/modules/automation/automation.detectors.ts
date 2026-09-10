import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { automationService } from "./automation.service";

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function isoWeek(d: Date): string {
  const onejan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - onejan.getTime()) / DAY_MS + onejan.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${week}`;
}

/** FIRST_SALE: verified vendor, has an active product, has never sold anything. */
async function detectFirstSale(): Promise<number> {
  const vendors = await prisma.vendor.findMany({
    where: {
      isSuspended: false,
      verificationStatus: "VERIFIED",
      products: { some: { isActive: true } },
      orderItems: { none: {} },
    },
    select: { id: true, userId: true, storeName: true },
    take: 200,
  });
  for (const vendor of vendors) {
    await automationService.scheduleAutomation({
      type: "FIRST_SALE",
      recipientUserId: vendor.userId,
      vendorId: vendor.id,
      subjectKey: `${vendor.id}:${isoWeek(new Date())}`,
      frequencyCapDays: 7,
      requiresMarketingConsent: false,
      title: "Get your first order",
      body: `Your store ${vendor.storeName} is live.`,
      data: { store_name: vendor.storeName },
    });
  }
  return vendors.length;
}

/**
 * CART_RECOVERY: items sitting in a buyer's cart past a per-vendor reminder
 * delay (default 2h, vendor-configurable via VendorAutomationSetting.config).
 * A cart can span multiple vendors' products, so it's evaluated once per
 * vendor represented in the cart, each against that vendor's own delay.
 */
async function detectCartRecovery(): Promise<number> {
  const widestCutoff = new Date(Date.now() - 60 * 60 * 1000); // API enforces reminderHours >= 1, so this is a safe pre-filter floor.
  const carts = await prisma.cart.findMany({
    where: { items: { some: { createdAt: { lte: widestCutoff } } } },
    select: {
      id: true,
      buyerId: true,
      items: { select: { id: true, createdAt: true, product: { select: { vendorId: true } } } },
    },
    take: 500,
  });

  const vendorConfigCache = new Map<string, { reminderHours: number }>();
  async function reminderHoursFor(vendorId: string): Promise<number> {
    if (!vendorConfigCache.has(vendorId)) {
      vendorConfigCache.set(vendorId, await automationService.getVendorAutomationConfig(vendorId, "CART_RECOVERY") as { reminderHours: number });
    }
    return vendorConfigCache.get(vendorId)!.reminderHours;
  }

  let scheduled = 0;
  for (const cart of carts) {
    if (cart.items.length === 0) continue;
    const vendorIds = new Set(cart.items.map((item) => item.product.vendorId));
    for (const vendorId of vendorIds) {
      const reminderHours = await reminderHoursFor(vendorId);
      const cutoff = new Date(Date.now() - reminderHours * 60 * 60 * 1000);
      const hasStaleItemForVendor = cart.items.some((item) => item.product.vendorId === vendorId && item.createdAt <= cutoff);
      if (!hasStaleItemForVendor) continue;
      await automationService.scheduleAutomation({
        type: "CART_RECOVERY",
        recipientUserId: cart.buyerId,
        vendorId,
        subjectKey: `${cart.id}:${vendorId}:${isoDate(new Date())}`,
        frequencyCapDays: 1,
        requiresMarketingConsent: true,
        title: "You left something in your cart",
        body: "Items are waiting in your cart.",
      });
      scheduled++;
    }
  }
  return scheduled;
}

/**
 * BUYER_WIN_BACK: for each vendor, a buyer who has bought from THAT vendor
 * before but not again within the vendor's own inactivity window (default
 * 45 days, vendor-configurable). Scoped per-vendor rather than
 * platform-wide, so each vendor's win-back reflects their own buyers.
 */
async function detectBuyerWinBack(): Promise<number> {
  const PAID_STATUSES = ["PAID", "DELIVERED", "COMPLETED"] as const;
  const vendors = await prisma.vendor.findMany({
    where: { isSuspended: false, orderItems: { some: {} } },
    select: { id: true, userId: true },
    take: 500,
  });

  let scheduled = 0;
  for (const vendor of vendors) {
    const { inactivityDays } = (await automationService.getVendorAutomationConfig(vendor.id, "BUYER_WIN_BACK")) as { inactivityDays: number };
    const cutoff = new Date(Date.now() - inactivityDays * DAY_MS);

    const buyers = await prisma.user.findMany({
      where: {
        role: "BUYER",
        isSuspended: false,
        orders: { some: { status: { in: [...PAID_STATUSES] }, vendorId: vendor.id } },
        NOT: {
          orders: { some: { status: { in: [...PAID_STATUSES] }, vendorId: vendor.id, createdAt: { gte: cutoff } } },
        },
      },
      select: { id: true },
      take: 200,
    });

    for (const buyer of buyers) {
      await automationService.scheduleAutomation({
        type: "BUYER_WIN_BACK",
        recipientUserId: buyer.id,
        vendorId: vendor.id,
        subjectKey: `${buyer.id}:${vendor.id}:${isoWeek(new Date())}`,
        frequencyCapDays: 30,
        requiresMarketingConsent: true,
        title: "We miss you at Eki",
        body: "Take a look at what's new.",
      });
      scheduled++;
    }
  }
  return scheduled;
}

/** REVIEW_REQUEST: delivered 1–14 days ago, no review yet. */
async function detectReviewRequest(): Promise<number> {
  const from = new Date(Date.now() - 14 * DAY_MS);
  const to = new Date(Date.now() - DAY_MS);
  const candidates = await prisma.order.findMany({
    where: { status: { in: ["DELIVERED", "COMPLETED"] }, deliveredAt: { gte: from, lte: to } },
    select: { id: true, orderNumber: true, buyerId: true },
    take: 500,
  });
  if (candidates.length === 0) return 0;
  const reviewed = await prisma.review.findMany({
    where: { orderId: { in: candidates.map((o) => o.id) } },
    select: { orderId: true },
  });
  const reviewedOrderIds = new Set(reviewed.map((r) => r.orderId));
  const orders = candidates.filter((o) => !reviewedOrderIds.has(o.id));
  for (const order of orders) {
    await automationService.scheduleAutomation({
      type: "REVIEW_REQUEST",
      recipientUserId: order.buyerId,
      subjectKey: order.id,
      requiresMarketingConsent: true,
      title: "How was your order?",
      body: `Order ${order.orderNumber} was delivered.`,
      data: { order_number: order.orderNumber },
    });
  }
  return orders.length;
}

/** LOW_STOCK_ALERT: reuses the threshold from the existing stock-alerts worker, routed through the new engine (push + in-app + email, not email-only). */
async function detectLowStockAlert(): Promise<number> {
  const LOW_STOCK_THRESHOLD = 5;
  const products = await prisma.product.findMany({
    where: { isActive: true, stock: { lte: LOW_STOCK_THRESHOLD } },
    select: { vendorId: true },
    take: 1000,
  });
  const byVendor = new Map<string, number>();
  for (const p of products) byVendor.set(p.vendorId, (byVendor.get(p.vendorId) ?? 0) + 1);

  for (const [vendorId, count] of byVendor) {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true } });
    if (!vendor) continue;
    await automationService.scheduleAutomation({
      type: "LOW_STOCK_ALERT",
      recipientUserId: vendor.userId,
      vendorId,
      subjectKey: `${vendorId}:${isoDate(new Date())}`,
      frequencyCapDays: 1,
      requiresMarketingConsent: false,
      title: "Low stock alert",
      body: `${count} product(s) are running low.`,
      data: { product_count: String(count) },
    });
  }
  return byVendor.size;
}

/** BUYER_REFERRAL: has purchased before, has never referred anyone. */
async function detectBuyerReferral(): Promise<number> {
  const accountAgeCutoff = new Date(Date.now() - 3 * DAY_MS);
  const candidates = await prisma.user.findMany({
    where: {
      role: "BUYER",
      isSuspended: false,
      referralCode: { not: null },
      createdAt: { lte: accountAgeCutoff },
      orders: { some: { status: { in: ["PAID", "DELIVERED", "COMPLETED"] } } },
    },
    select: { id: true, referralCode: true },
    take: 500,
  });
  if (candidates.length === 0) return 0;
  const referring = await prisma.referral.findMany({
    where: { referrerId: { in: candidates.map((b) => b.id) } },
    select: { referrerId: true },
  });
  const referrerIds = new Set(referring.map((r) => r.referrerId));
  const buyers = candidates.filter((b) => !referrerIds.has(b.id));

  let count = 0;
  for (const buyer of buyers) {
    count++;
    await automationService.scheduleAutomation({
      type: "BUYER_REFERRAL",
      recipientUserId: buyer.id,
      subjectKey: `${buyer.id}:${isoWeek(new Date())}`,
      frequencyCapDays: 30,
      requiresMarketingConsent: true,
      title: "Share Eki, earn rewards",
      body: `Share your code ${buyer.referralCode}.`,
      data: { referral_code: buyer.referralCode },
    });
  }
  return count;
}

/** PAYMENT_RECOVERY: a payment failed in the last 24h and the order is still unpaid. */
async function detectPaymentRecovery(): Promise<number> {
  const since = new Date(Date.now() - DAY_MS);
  const payments = await prisma.payment.findMany({
    where: { status: "FAILED", updatedAt: { gte: since }, order: { status: "PENDING" } },
    select: { id: true, order: { select: { id: true, orderNumber: true, buyerId: true, vendorId: true } } },
    take: 500,
  });
  for (const payment of payments) {
    if (!payment.order) continue;
    await automationService.scheduleAutomation({
      type: "PAYMENT_RECOVERY",
      recipientUserId: payment.order.buyerId,
      // AUTO-06 fix: without vendorId, listVendorActivity(vendorId) could
      // never show this run to any vendor — it was real and sending, just
      // permanently invisible in their Automation Activity.
      vendorId: payment.order.vendorId,
      subjectKey: payment.id,
      requiresMarketingConsent: false,
      title: "Your payment didn't go through",
      body: `Order ${payment.order.orderNumber} needs a new payment attempt.`,
      data: { order_number: payment.order.orderNumber },
    });
  }
  return payments.length;
}

/**
 * REORDER_REMINDER — Final Client Decision 4.
 *
 * Triggers after a completed+delivered order. For each delivered order in
 * the configured window, checks whether:
 *   1. The buyer has marketing consent.
 *   2. The product is still available (active, in stock).
 *   3. The buyer hasn't already reordered that product (completed order
 *      with the same productId after the original order date).
 *   4. The automation is enabled for that vendor.
 *   5. The dedupe key prevents a second reminder for the same order.
 *
 * Uses a fixed 14-day window from delivery as a default timing — mirrors
 * the REVIEW_REQUEST 14-day pattern, the simplest timing that works
 * without requiring a per-vendor "typical order interval" field that
 * doesn't currently exist in the schema.
 */
async function detectReorderReminder(): Promise<number> {
  const REMINDER_WINDOW_DAYS = 14;
  const from = new Date(Date.now() - REMINDER_WINDOW_DAYS * DAY_MS);
  const to = new Date(Date.now() - DAY_MS); // don't remind day-of delivery

  const orders = await prisma.order.findMany({
    where: {
      status: { in: ["DELIVERED", "COMPLETED", "AUTO_RELEASED"] },
      deliveredAt: { gte: from, lte: to },
    },
    select: {
      id: true,
      orderNumber: true,
      buyerId: true,
      vendorId: true,
      deliveredAt: true,
      items: {
        select: {
          productId: true,
          product: { select: { title: true, isActive: true, stock: true } },
        },
      },
    },
    take: 500,
  });

  let scheduled = 0;
  for (const order of orders) {
    for (const item of order.items) {
      // 1. Product must still be available.
      if (!item.product.isActive || item.product.stock <= 0) continue;

      // 2. Buyer must not have already reordered this exact product after
      //    this order was placed (prevents reminders for recent repurchases).
      const alreadyReordered = await prisma.orderItem.findFirst({
        where: {
          productId: item.productId,
          order: {
            buyerId: order.buyerId,
            status: { in: ["PAID", "DELIVERED", "COMPLETED", "AUTO_RELEASED"] },
            createdAt: { gt: order.deliveredAt ?? new Date(0) },
          },
        },
        select: { id: true },
      });
      if (alreadyReordered) continue;

      await automationService.scheduleAutomation({
        type: "REORDER_REMINDER",
        recipientUserId: order.buyerId,
        vendorId: order.vendorId,
        // Dedupe: one reminder per product per order, never resent.
        subjectKey: `${order.id}:${item.productId}`,
        requiresMarketingConsent: true,
        title: "Time to reorder?",
        body: `You ordered ${item.product.title} — need more?`,
        data: {
          order_number: order.orderNumber,
          product_title: item.product.title,
          product_id: item.productId,
        },
      });
      scheduled++;
    }
  }
  return scheduled;
}

/**
 * CHECKOUT_PAYMENT_FOLLOW_UP — Final Client Decision 4.
 *
 * Triggers when a marketplace Checkout is abandoned or its PaymentIntent
 * failed (separate from PAYMENT_RECOVERY, which is exclusively for Regular
 * Delivery subscription renewal payment failures).
 *
 * Uses the Checkout model (status: PENDING = not yet paid, SUCCEEDED =
 * payment captured, FAILED = PI confirmed failed). PaymentStatus enum in
 * Prisma is: PENDING | SUCCEEDED | FAILED — there is no PROCESSING value.
 *
 * CRITICAL: A real freshness recheck re-reads the checkout status from the
 * DB immediately before sending. If it is now SUCCEEDED, no message is sent.
 * This prevents messaging buyers whose payment succeeded after the initial
 * batch query ran (race-condition guard).
 *
 * Window: Checkouts that have been PENDING for more than 2 hours but less
 * than 48 hours. Stale enough to be abandoned, recent enough to be
 * actionable.
 */
async function detectCheckoutPaymentFollowUp(): Promise<number> {
  const MIN_AGE_MS = 2 * 60 * 60 * 1000;  // 2 hours — not a timing glitch
  const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours — still actionable
  const now = new Date();
  const minAge = new Date(now.getTime() - MAX_AGE_MS);
  const maxAge = new Date(now.getTime() - MIN_AGE_MS);

  // Query PENDING Checkouts (the checkout-level entity, not individual orders).
  // A checkout can span multiple orders, but we dedupe per checkout so the
  // buyer gets exactly one follow-up regardless of how many orders are in it.
  const pendingCheckouts = await prisma.checkout.findMany({
    where: {
      status: "PENDING",
      createdAt: { gte: minAge, lte: maxAge },
    },
    select: {
      id: true,
      buyerId: true,
      orders: {
        select: { id: true, orderNumber: true, vendorId: true },
        take: 1,
      },
    },
    take: 500,
  });

  let scheduled = 0;
  for (const checkout of pendingCheckouts) {
    const order = checkout.orders[0];
    if (!order) continue;

    // CRITICAL RECHECK — re-read the checkout status immediately before
    // deciding to send (guards against payment succeeding between the
    // batch query above and this point). This is the exact guard the client
    // specified: "immediately before sending, re-check real payment status."
    const fresh = await prisma.checkout.findUnique({
      where: { id: checkout.id },
      select: { status: true },
    });
    if (!fresh) continue;
    // Only send for still-pending checkouts. SUCCEEDED = paid, don't message.
    if (fresh.status !== "PENDING") continue;

    await automationService.scheduleAutomation({
      type: "CHECKOUT_PAYMENT_FOLLOW_UP",
      recipientUserId: checkout.buyerId,
      vendorId: order.vendorId ?? undefined,
      // Deterministic dedupe: one follow-up per checkout, never resent.
      subjectKey: `checkout_followup:${checkout.id}`,
      requiresMarketingConsent: true,
      title: "Complete your purchase",
      body: `Your order ${order.orderNumber} is waiting — complete payment to confirm your items.`,
      data: { order_number: order.orderNumber, order_id: order.id, checkout_id: checkout.id },
    });
    scheduled++;
  }
  return scheduled;
}


export const automationDetectors = {
  /**
   * Runs every detector that has no dependency on Regular Deliveries or
   * Community Buy data (those are wired in separately once those modules
   * exist). Intended to be called from a cron-triggered internal route,
   * not from request-handling code.
   */
  async runSweep(): Promise<Record<string, number>> {
    const results: Record<string, number> = {};
    const jobs: [string, () => Promise<number>][] = [
      ["FIRST_SALE", detectFirstSale],
      ["CART_RECOVERY", detectCartRecovery],
      ["BUYER_WIN_BACK", detectBuyerWinBack],
      ["REVIEW_REQUEST", detectReviewRequest],
      ["LOW_STOCK_ALERT", detectLowStockAlert],
      ["BUYER_REFERRAL", detectBuyerReferral],
      ["PAYMENT_RECOVERY", detectPaymentRecovery],
      // Final Client Decision 4 — new automation types:
      ["REORDER_REMINDER", detectReorderReminder],
      ["CHECKOUT_PAYMENT_FOLLOW_UP", detectCheckoutPaymentFollowUp],
    ];
    for (const [name, job] of jobs) {
      try {
        results[name] = await job();
      } catch (error) {
        logger.error("Automation detector failed", { detector: name, error: error instanceof Error ? error.message : String(error) });
        results[name] = -1;
      }
    }
    return results;
  },
};

