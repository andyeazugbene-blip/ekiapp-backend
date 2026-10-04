import { assertManualVerificationAllowed, deriveVendorProviderReadiness, isProviderControlledVendor } from "../vendors/vendor-provider-readiness";
import {
  OrderStatus,
  PaymentStatus,
  UserRole,
  VendorVerificationStatus,
  WalletTransactionType,
} from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import { assertApprovedLaunchCountry } from "../vendors/vendors.service";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export interface PaginationQuery {
  limit: number;
  cursor?: string;
}

export function parsePagination(query: Record<string, unknown>): PaginationQuery {
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
      throw new AppError(`Invalid limit (1-${MAX_LIMIT})`, 400);
    }
    limit = parsed;
  }
  const cursor =
    typeof query.cursor === "string" && query.cursor.length > 0 ? query.cursor : undefined;
  return { limit, cursor };
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: Record<string, T>,
  field: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new AppError(`Invalid ${field}`, 400);
  const upper = value.toUpperCase();
  if (upper in allowed) return allowed[upper as keyof typeof allowed];
  throw new AppError(`Invalid ${field}`, 400);
}

async function paginate<TItem extends { id: string }>(
  fetcher: (args: { take: number; cursor?: { id: string }; skip?: number }) => Promise<TItem[]>,
  pagination: PaginationQuery,
): Promise<{ items: TItem[]; nextCursor: string | null }> {
  const items = await fetcher({
    take: pagination.limit + 1,
    ...(pagination.cursor ? { cursor: { id: pagination.cursor }, skip: 1 } : {}),
  });
  let nextCursor: string | null = null;
  if (items.length > pagination.limit) {
    const next = items.pop();
    nextCursor = next?.id ?? null;
  }
  return { items, nextCursor };
}

/**
 * Handbook 14.8 L585: a payment that did not succeed collected no funds, so
 * no Eki fee / vendor earnings exist. Never present the *estimated* split of a
 * failed or pending payment as if it were money movement.
 */
function scrubUnpaidSplit<T extends { status?: string; platformFeeAmount?: number | null; vendorEarningsAmount?: number | null }>(payment: T | null | undefined): (T & { moneyCollected: boolean }) | null {
  if (!payment) return null;
  const collected = payment.status === "SUCCEEDED";
  return {
    ...payment,
    platformFeeAmount: collected ? payment.platformFeeAmount ?? null : null,
    vendorEarningsAmount: collected ? payment.vendorEarningsAmount ?? null : null,
    moneyCollected: collected,
  };
}

function scrubOrderSplit<T extends { platformFeeAmount?: number | null; vendorEarnings?: number | null; payment?: { status?: string } | null }>(order: T): T {
  const collected = order.payment?.status === "SUCCEEDED";
  if (collected) return order;
  return { ...order, platformFeeAmount: null, vendorEarnings: null };
}

export const adminListingsService = {
  async listUsers(query: Record<string, unknown>) {
    const role = optionalEnum(query.role, UserRole, "role");
    const pagination = parsePagination(query);
    const search = typeof query.q === "string" && query.q.trim().length > 0 ? query.q.trim() : undefined;
    const status = typeof query.status === "string" ? query.status.toLowerCase() : undefined;
    if (status && !["active", "suspended", "anonymised"].includes(status)) throw new AppError("Invalid status", 400);
    const includeTest = query.includeTest === "true";

    const where: Record<string, unknown> = {};
    if (role) where.role = role;
    if (status === "anonymised") where.anonymisedAt = { not: null };
    else if (status === "suspended") { where.isSuspended = true; where.anonymisedAt = null; }
    else if (status === "active") { where.isSuspended = false; where.anonymisedAt = null; }
    if (!includeTest) where.isTest = false;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { id: search },
        { vendor: { storeName: { contains: search, mode: "insensitive" } } },
      ];
    }

    const [page, total] = await Promise.all([
      paginate(
        ({ take, cursor, skip }) =>
          prisma.user.findMany({
            where: where as never,
            select: {
              id: true,
              email: true,
              name: true,
              avatar: true,
              role: true,
              isSuspended: true,
              suspendedReason: true,
              suspendedAt: true,
              anonymisedAt: true,
              lastActiveAt: true,
              isTest: true,
              createdAt: true,
              updatedAt: true,
              vendor: { select: { id: true, storeName: true } },
              _count: { select: { orders: true } },
            },
            orderBy: CURSOR_ORDER_BY,
            take,
            cursor,
            skip,
          }),
        pagination,
      ),
      prisma.user.count({ where: where as never }),
    ]);
    return { ...page, total };
  },

  /**
   * The admin-web user detail screen's data source. A support agent
   * investigating an account needs more than the bare profile row — the
   * same kind of context getVendor() below already gives for a store
   * (recent orders, related profiles) — so this joins in exactly that,
   * read-only, no new mutation surface:
   *  - vendor / organiser / supplier profile snapshots, if this account has
   *    them (a user can hold more than one capability at once).
   *  - their 10 most recent orders as a buyer, plus a total count.
   *  - the id of their in-app support conversation, if they've ever started
   *    one, so an agent can jump straight to it instead of searching the
   *    shared inbox by name.
   */
  async getUser(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        country: true,
        role: true,
        isSuspended: true,
        suspendedReason: true,
        suspendedAt: true,
        suspendedById: true,
        suspendedUntil: true,
        suspensionEvidence: true,
        anonymisedAt: true,
        lastActiveAt: true,
        isTest: true,
        avatar: true,
        trustScore: true,
        emailVerifiedAt: true,
        createdAt: true,
        updatedAt: true,
        vendor: {
          select: { id: true, storeName: true, verificationStatus: true, isSuspended: true, country: true },
        },
        organiserProfile: {
          select: { id: true, isVerified: true, isRestricted: true, country: true },
        },
        supplierAccount: {
          select: { id: true, supplierState: true, chargesEnabled: true },
        },
      },
    });
    if (!user) throw new AppError("User not found", 404);

    const [recentOrders, orderCount, supportConversation] = await Promise.all([
      prisma.order.findMany({
        where: { buyerId: userId },
        select: { id: true, orderNumber: true, status: true, totalAmount: true, currency: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
      prisma.order.count({ where: { buyerId: userId } }),
      prisma.conversation.findFirst({
        where: { type: "SUPPORT", OR: [{ participantA: userId }, { participantB: userId }] },
        select: { id: true },
        orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
      }),
    ]);

    const suspendedBy = user.suspendedById
      ? await prisma.user.findUnique({ where: { id: user.suspendedById }, select: { name: true, email: true } })
      : null;

    return {
      ...user,
      suspendedByName: suspendedBy?.name ?? suspendedBy?.email ?? null,
      recentOrders,
      orderCount,
      supportConversationId: supportConversation?.id ?? null,
    };
  },

  async getVendor(vendorId: string) {
    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      include: {
        user: { select: { id: true, email: true, name: true, role: true, isSuspended: true, createdAt: true } },
        _count: { select: { products: true, payoutMethods: true } },
      },
    });
    if (!vendor) throw new AppError("Vendor not found", 404);

    const paidOrderStatuses = { notIn: ["PENDING", "FAILED", "CANCELLED"] } as never;
    const [products, recentOrders, reviewAgg, totalRevenue, subscription, storeOrders, completedOrders, gmvByCurrency, disputeCounts, suspendedBy] = await Promise.all([
      prisma.product.findMany({
        where: { vendorId },
        select: { id: true, title: true, priceInCents: true, currency: true, stock: true, isActive: true, images: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.order.findMany({
        where: { vendorId },
        select: { id: true, orderNumber: true, status: true, totalAmount: true, currency: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
      prisma.review.aggregate({
        where: { vendorId, status: "APPROVED" },
        _avg: { rating: true },
        _count: true,
      }),
      prisma.orderItem.aggregate({
        where: { vendorId, order: { status: { notIn: ["PENDING", "FAILED", "CANCELLED"] } } },
        _sum: { totalAmount: true },
      }),
      // Same source as the list (Handbook 14.7 L571: list and detail must
      // agree). The detail used to receive no subscription at all and fell
      // back to "free".
      prisma.vendorSubscription.findUnique({
        where: { vendorId },
        select: { plan: true, status: true, currentPeriodStart: true, currentPeriodEnd: true, cancelledAt: true, stripeSubscriptionId: true },
      }),
      prisma.order.count({ where: { vendorId, status: paidOrderStatuses } }),
      prisma.order.count({ where: { vendorId, status: "COMPLETED" as never } }),
      // GMV stays in each order's ORIGINAL currency - never summed across currencies.
      prisma.order.groupBy({
        by: ["currency"],
        where: { vendorId, status: paidOrderStatuses },
        _sum: { totalAmount: true },
        _count: { id: true },
      }),
      prisma.dispute.groupBy({ by: ["status"], where: { vendorId }, _count: { id: true } }),
      vendor.suspendedById
        ? prisma.user.findUnique({ where: { id: vendor.suspendedById }, select: { name: true, email: true } })
        : Promise.resolve(null),
    ]);

    const readiness = deriveVendorProviderReadiness(vendor);
    return {
      ...vendor,
      products,
      recentOrders,
      avgRating: reviewAgg._avg.rating,
      totalReviews: reviewAgg._count,
      totalRevenue: totalRevenue._sum.totalAmount ?? 0,
      subscription,
      storeOrders,
      completedOrders,
      gmvByCurrency: gmvByCurrency.map((g) => ({ currency: g.currency, amount: g._sum.totalAmount ?? 0, orders: g._count.id })),
      disputes: {
        total: disputeCounts.reduce((n, d) => n + d._count.id, 0),
        open: disputeCounts.filter((d) => d.status === "OPEN").reduce((n, d) => n + d._count.id, 0),
      },
      suspendedByName: suspendedBy?.name ?? suspendedBy?.email ?? null,
      provider: {
        stage: readiness.stage,
        identityState: readiness.identity.state,
        chargesEnabled: readiness.connect.chargesEnabled,
        payoutsEnabled: readiness.connect.payoutsEnabled,
      },
    };
  },

  async updateVendor(vendorId: string, input: Record<string, unknown>) {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new AppError("Vendor not found", 404);
    const fields = ["storeName", "description", "contactEmail", "contactPhone", "country", "city", "businessType", "sellerRegion", "currency"] as const;
    const data: Record<string, string | null> = {};
    for (const field of fields) {
      if (input[field] !== undefined) {
        if (input[field] !== null && typeof input[field] !== "string") throw new AppError(`Invalid ${field}`, 400);
        data[field] = typeof input[field] === "string" ? input[field].trim() : null;
      }
    }
    if (Object.keys(data).length === 0) throw new AppError("No vendor fields to update", 400);
    // This edits the vendor's PRIMARY market (Vendor.country) — same
    // launch-market gate as vendor self-service onboarding/profile edits, so
    // an admin can't set a vendor's primary country to somewhere outside the
    // approved launch markets either (unchanged values stay grandfathered,
    // same as the vendor-facing gate). Additional markets are managed
    // separately via VendorMarketAssignment (admin-vendors.controller.ts).
    if (data.country !== undefined) {
      assertApprovedLaunchCountry(data.country, vendor.country);
    }
    const before: Record<string, unknown> = {};
    for (const field of Object.keys(data)) before[field] = (vendor as Record<string, unknown>)[field];
    const updated = await prisma.vendor.update({ where: { id: vendorId }, data });
    return { vendor: updated, before, after: data };
  },

  async deleteVendor(vendorId: string, reason?: string) {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true } });
    if (!vendor) throw new AppError("Vendor not found", 404);

    // Vendor.user is onDelete: Cascade, so deleting the underlying User row
    // takes the Vendor (and its products/wallet/verification docs, which are
    // also Cascade) with it in one shot. If the vendor has order/payout/
    // payout-method/wallet-transaction history, those relations are RESTRICT
    // and this throws — deleteUser catches that and anonymizes instead of
    // silently leaving a half-deleted vendor or an orphaned login account.
    const result = await this.deleteUser(vendor.userId, reason ?? "Vendor deleted by admin");
    return { id: vendorId, deleted: result.hardDeleted, hardDeleted: result.hardDeleted };
  },

  async getOrder(orderId: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { include: { product: { select: { id: true, title: true, images: true, currency: true, priceInCents: true } } } },
        payment: {
          select: {
            id: true, status: true, stripePaymentIntentId: true, provider: true,
            amount: true, platformFeeAmount: true, vendorEarningsAmount: true,
            currency: true, processedAt: true,
            sellerPlanId: true, sellerPlanSlug: true, commissionBps: true, withdrawalFeeBps: true,
          },
        },
        buyer: { select: { id: true, name: true, email: true } },
        deliveryZone: { select: { id: true, name: true, country: true, baseFeeAmount: true, feePerKgAmount: true } },
        checkout: { select: { id: true, stripePaymentIntentId: true, totalAmount: true, metadata: true } },
      },
    });
    if (!order) throw new AppError("Order not found", 404);
    let vInfo: Record<string, unknown> | null = null; if (order.vendorId) { vInfo = await prisma.vendor.findUnique({ where: { id: order.vendorId }, select: { storeName: true, contactEmail: true, country: true, city: true, verificationStatus: true } }); }
    const [refunds, dispute, payoutRequests, webhookEvents] = await Promise.all([
      prisma.refund.findMany({ where: { orderId }, orderBy: { createdAt: "desc" }, take: 20 }),
      prisma.dispute.findUnique({ where: { orderId }, select: { id: true, status: true, reason: true, createdAt: true } }),
      order.vendorId
        ? prisma.payoutRequest.findMany({ where: { vendorId: order.vendorId }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, status: true, amount: true, currency: true, createdAt: true } })
        : Promise.resolve([]),
      prisma.webhookEvent.findMany({
        where: { OR: [{ orderId: { in: [orderId, ...(order.checkoutId ? [order.checkoutId] : [])] } }, ...(order.payment ? [{ paymentId: order.payment.id }] : [])] },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, stripeEventId: true, eventType: true, status: true, createdAt: true, processedAt: true },
      }),
    ]);
    const scrubbed = scrubOrderSplit(order as never as { platformFeeAmount?: number | null; vendorEarnings?: number | null; payment?: { status?: string } | null }) as typeof order;
    return {
      ...scrubbed,
      payment: scrubUnpaidSplit(order.payment),
      vendorName: vInfo?.storeName ?? null,
      vendorInfo: vInfo,
      refunds,
      dispute,
      payoutRequests,
      webhookEvents,
    };
  },

  async listVendors(query: Record<string, unknown>) {
    const verificationStatus = optionalEnum(query.status, VendorVerificationStatus, "status");
    const pagination = parsePagination(query);
    const isSuspended = query.suspended === "true" ? true : query.suspended === "false" ? false : undefined;
    const searchTerm = typeof query.q === "string" && query.q.trim().length > 0
      ? query.q.trim()
      : typeof query.search === "string" && query.search.trim().length > 0 ? query.search.trim() : undefined;

    const and: Record<string, unknown>[] = [];
    const where: Record<string, unknown> = {};
    if (verificationStatus) where.verificationStatus = verificationStatus;
    if (isSuspended !== undefined) where.isSuspended = isSuspended;
    // Handbook 14.7: payment readiness is its own dimension, never implied by "verified".
    if (query.payment === "ready") { where.stripeChargesEnabled = true; where.stripePayoutsEnabled = true; }
    else if (query.payment === "not_ready") and.push({ OR: [{ stripeChargesEnabled: false }, { stripePayoutsEnabled: false }] });
    if (typeof query.country === "string" && query.country.length > 0) where.country = { equals: query.country, mode: "insensitive" };
    if (query.includeTest !== "true") where.isTest = false;
    if (typeof query.subscription === "string" && query.subscription.length > 0) {
      // VendorSubscription has no Prisma relation on Vendor, so filter by id set.
      const plan = query.subscription.toUpperCase();
      if (plan === "NONE") {
        const subscribed = await prisma.vendorSubscription.findMany({ select: { vendorId: true } });
        and.push({ id: { notIn: subscribed.map((x) => x.vendorId) } });
      } else {
        const rows = await prisma.vendorSubscription.findMany({ where: { plan: plan as never }, select: { vendorId: true } });
        and.push({ id: { in: rows.map((x) => x.vendorId) } });
      }
    }
    if (searchTerm) {
      and.push({ OR: [
        { storeName: { contains: searchTerm, mode: "insensitive" } },
        { contactEmail: { contains: searchTerm, mode: "insensitive" } },
        { city: { contains: searchTerm, mode: "insensitive" } },
        { country: { contains: searchTerm, mode: "insensitive" } },
        { user: { name: { contains: searchTerm, mode: "insensitive" } } },
        { user: { email: { contains: searchTerm, mode: "insensitive" } } },
        { id: searchTerm },
      ] });
    }
    if (and.length > 0) where.AND = and;

    const [{ items, nextCursor }, total] = await Promise.all([
      paginate(
        ({ take, cursor, skip }) =>
          prisma.vendor.findMany({
            where: where as never,
            include: {
              user: { select: { id: true, email: true, name: true, role: true } },
            },
            orderBy: CURSOR_ORDER_BY,
            take,
            cursor,
            skip,
          }),
        pagination,
      ),
      prisma.vendor.count({ where: where as never }),
    ]);

    const vendorIds = items.map((v) => v.id);
    if (vendorIds.length === 0) return { items: [], nextCursor, total };

    const [orderCounts, revenueSums, subscriptions] = await Promise.all([
      prisma.order.groupBy({
        by: ["vendorId"],
        where: { vendorId: { in: vendorIds }, status: { notIn: ["PENDING", "FAILED", "CANCELLED"] } },
        _count: { id: true },
      }),
      prisma.orderItem.groupBy({
        by: ["vendorId"],
        where: { vendorId: { in: vendorIds }, order: { status: { notIn: ["PENDING", "FAILED", "CANCELLED"] } } },
        _sum: { totalAmount: true },
      }),
      prisma.vendorSubscription.findMany({
        where: { vendorId: { in: vendorIds } },
        select: { vendorId: true, plan: true, status: true, currentPeriodEnd: true },
      }),
    ]);

    const orderMap = new Map(orderCounts.map((o) => [o.vendorId, o._count.id]));
    const revenueMap = new Map(revenueSums.map((r) => [r.vendorId, r._sum.totalAmount ?? 0]));
    const subMap = new Map(subscriptions.map((s) => [s.vendorId, s]));

    const enriched = items.map((v) => {
      const sub = subMap.get(v.id);
      const readiness = deriveVendorProviderReadiness(v);
      return {
        ...v,
        orderCount: orderMap.get(v.id) ?? 0,
        totalRevenue: revenueMap.get(v.id) ?? 0,
        // null = no subscription record. The list used to invent "FREE"/"ACTIVE" here,
        // contradicting the detail page (Handbook 14.7 L569-571).
        subscriptionPlan: sub?.plan ?? null,
        subscriptionStatus: sub?.status ?? null,
        subscriptionPeriodEnd: sub?.currentPeriodEnd ?? null,
        provider: {
          stage: readiness.stage,
          identityState: readiness.identity.state,
          chargesEnabled: readiness.connect.chargesEnabled,
          payoutsEnabled: readiness.connect.payoutsEnabled,
        },
      };
    });

    return { items: enriched, nextCursor, total };
  },

  async listProducts(query: Record<string, unknown>) {
    const pagination = parsePagination(query);
    const isActiveRaw = query.isActive;
    let isActive: boolean | undefined;
    if (isActiveRaw !== undefined) {
      if (isActiveRaw === "true") isActive = true;
      else if (isActiveRaw === "false") isActive = false;
      else throw new AppError("Invalid isActive", 400);
    }

    const { items, nextCursor } = await paginate(
      ({ take, cursor, skip }) =>
        prisma.product.findMany({
          where: isActive === undefined ? {} : { isActive },
          include: { vendor: { select: { storeName: true, country: true, city: true } } },
          orderBy: CURSOR_ORDER_BY,
          take,
          cursor,
          skip,
        }),
      pagination,
    );
    // Map vendor name to top level
    const enriched = (items as any[]).map((p: any) => ({ ...p, vendorName: p.vendor?.storeName ?? null, vendor: undefined }));
    return { items: enriched, nextCursor };
  },

  async getProduct(productId: string) {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        vendor: {
          select: {
            storeName: true, contactEmail: true, country: true, city: true,
            stripeAccountId: true, verificationStatus: true,
          },
        },
        orderItems: {
          select: { id: true, quantity: true, totalAmount: true, orderId: true },
          orderBy: { id: "desc" },
          take: 10,
        },
      },
    });
    if (!product) throw new AppError("Product not found", 404);
    const deliveryZones = await prisma.deliveryZone.findMany({
      where: { vendorId: product.vendorId, isActive: true },
      select: { name: true, country: true, baseFeeAmount: true, feePerKgAmount: true },
    });
    const globalZones = await prisma.deliveryZone.findMany({
      where: { vendorId: null, isActive: true, country: product.vendor?.country ?? undefined },
      select: { name: true, country: true, baseFeeAmount: true, feePerKgAmount: true },
    });
    return { ...product, deliveryZones: [...deliveryZones, ...globalZones], vendorName: product.vendor?.storeName ?? null };
  },

  async listOrders(query: Record<string, unknown>) {
    const status = optionalEnum(query.status, OrderStatus, "status");
    const pagination = parsePagination(query);
    const search = typeof query.q === "string" && query.q.trim().length > 0 ? query.q.trim() : undefined;
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (typeof query.vendorId === "string" && query.vendorId) where.vendorId = query.vendorId;
    if (typeof query.buyerId === "string" && query.buyerId) where.buyerId = query.buyerId;
    if (query.includeTest !== "true") where.isTest = false;
    if (search) {
      where.OR = [
        { orderNumber: { contains: search, mode: "insensitive" } },
        { id: search },
        { buyer: { email: { contains: search, mode: "insensitive" } } },
        { buyer: { name: { contains: search, mode: "insensitive" } } },
        { payment: { stripePaymentIntentId: { contains: search } } },
      ];
    }

    const [page, total] = await Promise.all([
      paginate(
        ({ take, cursor, skip }) =>
          prisma.order.findMany({
            where: where as never,
            include: {
              items: { select: { id: true, productTitle: true, quantity: true, unitAmount: true, totalAmount: true } },
              payment: { select: { id: true, status: true, stripePaymentIntentId: true, provider: true, amount: true, platformFeeAmount: true, vendorEarningsAmount: true, currency: true, failureCode: true, failureMessage: true, providerStatus: true } },
              buyer: { select: { id: true, name: true, email: true } },
            },
            orderBy: CURSOR_ORDER_BY,
            take,
            cursor,
            skip,
          }),
        pagination,
      ),
      prisma.order.count({ where: where as never }),
    ]);

    const vids = [...new Set(page.items.map((o) => o.vendorId).filter((v): v is string => !!v))];
    const vendors = vids.length ? await prisma.vendor.findMany({ where: { id: { in: vids } }, select: { id: true, storeName: true } }) : [];
    const vendorName = new Map(vendors.map((v) => [v.id, v.storeName]));

    return {
      items: page.items.map((o) => ({
        ...scrubOrderSplit(o as never as { platformFeeAmount?: number | null; vendorEarnings?: number | null; payment?: { status?: string } | null }),
        payment: scrubUnpaidSplit(o.payment),
        vendorName: o.vendorId ? vendorName.get(o.vendorId) ?? null : null,
      })),
      nextCursor: page.nextCursor,
      total,
    };
  },

  async listPayments(query: Record<string, unknown>) {
    const status = optionalEnum(query.status, PaymentStatus, "status");
    const pagination = parsePagination(query);
    const search = typeof query.q === "string" && query.q.trim().length > 0 ? query.q.trim() : undefined;
    const and: Record<string, unknown>[] = [];
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (typeof query.provider === "string" && query.provider) where.provider = query.provider;
    if (query.includeTest !== "true") where.isTest = false;
    if (typeof query.vendorId === "string" && query.vendorId) and.push({ order: { vendorId: query.vendorId } });
    const from = typeof query.from === "string" ? new Date(query.from) : null;
    const to = typeof query.to === "string" ? new Date(query.to) : null;
    if (from && !Number.isNaN(from.getTime())) and.push({ createdAt: { gte: from } });
    if (to && !Number.isNaN(to.getTime())) and.push({ createdAt: { lte: to } });
    if (search) {
      and.push({ OR: [
        { stripePaymentIntentId: { contains: search } },
        { id: search },
        { order: { orderNumber: { contains: search, mode: "insensitive" } } },
        { order: { buyer: { email: { contains: search, mode: "insensitive" } } } },
        { order: { buyer: { name: { contains: search, mode: "insensitive" } } } },
      ] });
    }
    if (and.length) where.AND = and;

    const [{ items, nextCursor }, total] = await Promise.all([
      paginate(
        ({ take, cursor, skip }) =>
          prisma.payment.findMany({
            where: where as never,
            include: {
              order: {
                select: {
                  id: true, orderNumber: true, status: true, totalAmount: true, currency: true,
                  vendorId: true, buyerId: true,
                  buyer: { select: { name: true, email: true } },
                },
              },
            },
            orderBy: CURSOR_ORDER_BY,
            take, cursor, skip,
          }),
        pagination,
      ),
      prisma.payment.count({ where: where as never }),
    ]);

    // Enrich with vendor store names (Order has vendorId as plain field, no relation)
    const vids = [...new Set(items.map((p) => p.order?.vendorId).filter(Boolean))] as string[];
    const vm = new Map<string, string>();
    if (vids.length > 0) {
      const vendors = await prisma.vendor.findMany({ where: { id: { in: vids } }, select: { id: true, storeName: true } });
      for (const v of vendors) vm.set(v.id, v.storeName);
    }

    return {
      items: items.map((p) => ({ ...scrubUnpaidSplit(p), vendorName: p.order?.vendorId ? vm.get(p.order.vendorId) ?? null : null })),
      nextCursor,
      total,
    };
  },

  async listWalletTransactions(query: Record<string, unknown>) {
    const type = optionalEnum(query.type, WalletTransactionType, "type");
    const pagination = parsePagination(query);
    const vendorId =
      typeof query.vendorId === "string" && query.vendorId.length > 0
        ? query.vendorId
        : undefined;

    return paginate(
      ({ take, cursor, skip }) =>
        prisma.walletTransaction.findMany({
          where: {
            ...(type ? { type } : {}),
            ...(vendorId ? { vendorId } : {}),
          },
          include: {
            vendor: { select: { id: true, storeName: true } },
            order: { select: { id: true, orderNumber: true, status: true, totalAmount: true, currency: true } },
            payment: { select: { id: true, status: true, stripePaymentIntentId: true, provider: true } },
            payoutRequest: { select: { id: true, status: true, amount: true } },
          },
          orderBy: CURSOR_ORDER_BY,
          take,
          cursor,
          skip,
        }),
      pagination,
    );
  },

  async approveVendor(vendorId: string, adminId?: string) {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new AppError("Vendor not found", 404);
    // Handbook 14.3: approval comes from the provider (Stripe), never an admin button.
    assertManualVerificationAllowed(vendor, await prisma.verificationDocument.count({ where: { vendorId, deletedAt: null } }));
    const now = new Date();
    const [updated] = await prisma.$transaction([
      prisma.vendor.update({
        where: { id: vendorId },
        data: { verificationStatus: VendorVerificationStatus.VERIFIED },
      }),
      prisma.verificationDocument.updateMany({
        where: { vendorId, deletedAt: null },
        data: {
          status: "APPROVED",
          reviewedAt: now,
          reviewedById: adminId,
          rejectionReason: null,
          deleteAfterAt: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
        },
      }),
    ]);
    return updated;
  },

  async rejectVendor(vendorId: string, adminId?: string, reason?: string) {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new AppError("Vendor not found", 404);
    assertManualVerificationAllowed(vendor, await prisma.verificationDocument.count({ where: { vendorId, deletedAt: null } }));
    const now = new Date();
    const [updated] = await prisma.$transaction([
      prisma.vendor.update({
        where: { id: vendorId },
        data: { verificationStatus: VendorVerificationStatus.REJECTED },
      }),
      prisma.verificationDocument.updateMany({
        where: { vendorId, deletedAt: null },
        data: {
          status: "REJECTED",
          reviewedAt: now,
          reviewedById: adminId,
          rejectionReason: reason,
          deleteAfterAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        },
      }),
    ]);
    return updated;
  },

  async approveProduct(productId: string) {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new AppError("Product not found", 404);
    return prisma.product.update({
      where: { id: productId },
      data: { isActive: true },
    });
  },

  async disableProduct(productId: string) {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new AppError("Product not found", 404);
    return prisma.product.update({
      where: { id: productId },
      data: { isActive: false },
    });
  },


  async getPayment(paymentId: string) {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        order: {
          select: {
            id: true, orderNumber: true, status: true, totalAmount: true, currency: true,
            vendorId: true, buyerId: true, deliveryAddress: true, createdAt: true,
            deliveryZone: { select: { name: true, country: true } },
            buyer: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });
    if (!payment) throw new AppError("Payment not found", 404);
    let vendorName: string | null = null;
    if (payment.order?.vendorId) {
      const v = await prisma.vendor.findUnique({ where: { id: payment.order.vendorId }, select: { storeName: true } });
      vendorName = v?.storeName ?? null;
    }
    // Handbook 14.8 L584: webhook receipt + refunds so staff can reconcile
    // without a database query. WebhookEvent.orderId holds the order id or
    // (for checkout-level events) the checkout id.
    const checkoutRow = await prisma.order.findUnique({ where: { id: payment.orderId }, select: { checkoutId: true } });
    const refs = [payment.orderId, ...(checkoutRow?.checkoutId ? [checkoutRow.checkoutId] : [])];
    const [webhookEvents, refunds] = await Promise.all([
      prisma.webhookEvent.findMany({
        where: { OR: [{ paymentId: payment.id }, { orderId: { in: refs } }] },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, stripeEventId: true, eventType: true, status: true, createdAt: true, processedAt: true },
      }),
      prisma.refund.findMany({ where: { orderId: payment.orderId }, orderBy: { createdAt: "desc" }, take: 20 }),
    ]);
    return { ...scrubUnpaidSplit(payment), vendorName, webhookEvents, refunds };
  },

  async getWalletTransaction(txId: string) {
    const tx = await prisma.walletTransaction.findUnique({
      where: { id: txId },
      include: {
        vendor: { select: { id: true, storeName: true, contactEmail: true, country: true } },
        order: { select: { id: true, orderNumber: true, status: true, totalAmount: true, currency: true, createdAt: true } },
        payment: { select: { id: true, status: true, stripePaymentIntentId: true, provider: true, amount: true, platformFeeAmount: true, vendorEarningsAmount: true } },
        payoutRequest: { select: { id: true, status: true, amount: true, netAmount: true, createdAt: true } },
      },
    });
    if (!tx) throw new AppError("Wallet transaction not found", 404);
    return tx;
  },

  async getVendorStats() {
    const [
      total,
      verified,
      pending,
      rejected,
      suspended,
      withOrders,
      totalGmv,
    ] = await Promise.all([
      prisma.vendor.count(),
      prisma.vendor.count({ where: { verificationStatus: VendorVerificationStatus.VERIFIED, isSuspended: false } }),
      prisma.vendor.count({ where: { verificationStatus: VendorVerificationStatus.PENDING } }),
      prisma.vendor.count({ where: { verificationStatus: VendorVerificationStatus.REJECTED } }),
      prisma.vendor.count({ where: { isSuspended: true } }),
      prisma.vendor.count({
        where: {
          orderItems: { some: { order: { status: { notIn: ["PENDING", "FAILED", "CANCELLED"] } } } },
        },
      }),
      prisma.orderItem.aggregate({
        where: { order: { status: { notIn: ["PENDING", "FAILED", "CANCELLED"] } } },
        _sum: { totalAmount: true },
      }),
    ]);

    // `active` (=verified & not suspended) is kept for old callers; `approved`
    // is the same number, named for what it is. Never add the two together
    // (that is how Approved once exceeded Total).
    const active = verified;
    const unverified = total - verified;
    const [paymentReady, testVendors] = await Promise.all([
      prisma.vendor.count({ where: { stripeChargesEnabled: true, stripePayoutsEnabled: true } }),
      prisma.vendor.count({ where: { isTest: true } }),
    ]);
    const withoutOrders = total - withOrders;
    const gmv = totalGmv._sum.totalAmount ?? 0;
    const avgRevenue = withOrders > 0 ? Math.round(gmv / withOrders) : 0;

    return {
      total,
      approved: verified,
      paymentReady,
      testVendors,
      active,
      pending,
      rejected,
      suspended,
      verified,
      unverified,
      withOrders,
      withoutOrders,
      avgRevenue,
      gmv,
    };
  },

  async bulkApproveVendors(vendorIds: string[], adminId: string) {
    const candidates = await prisma.vendor.findMany({
      where: { id: { in: vendorIds }, verificationStatus: { not: VendorVerificationStatus.VERIFIED } },
      select: { id: true, stripeVerificationSessionId: true, stripeAccountId: true },
    });
    // Handbook 14.3: provider-controlled vendors are never bulk-approved.
    const vendors = candidates.filter((v) => !isProviderControlledVendor(v));
    const skippedProviderManaged = candidates.length - vendors.length;
    if (vendors.length === 0) return { affected: 0, skippedProviderManaged };
    const ids = vendors.map((v) => v.id);
    const now = new Date();
    await prisma.$transaction([
      prisma.vendor.updateMany({
        where: { id: { in: ids } },
        data: { verificationStatus: VendorVerificationStatus.VERIFIED },
      }),
      prisma.verificationDocument.updateMany({
        where: { vendorId: { in: ids }, deletedAt: null },
        data: { status: "APPROVED", reviewedAt: now, reviewedById: adminId, rejectionReason: null },
      }),
    ]);
    return { affected: ids.length, skippedProviderManaged };
  },

  async bulkRejectVendors(vendorIds: string[], adminId: string, reason?: string) {
    const candidates = await prisma.vendor.findMany({
      where: { id: { in: vendorIds }, verificationStatus: { not: VendorVerificationStatus.REJECTED } },
      select: { id: true, stripeVerificationSessionId: true, stripeAccountId: true },
    });
    const vendors = candidates.filter((v) => !isProviderControlledVendor(v));
    const skippedProviderManaged = candidates.length - vendors.length;
    if (vendors.length === 0) return { affected: 0, skippedProviderManaged };
    const ids = vendors.map((v) => v.id);
    const now = new Date();
    await prisma.$transaction([
      prisma.vendor.updateMany({
        where: { id: { in: ids } },
        data: { verificationStatus: VendorVerificationStatus.REJECTED },
      }),
      prisma.verificationDocument.updateMany({
        where: { vendorId: { in: ids }, deletedAt: null },
        data: { status: "REJECTED", reviewedAt: now, reviewedById: adminId, rejectionReason: reason },
      }),
    ]);
    return { affected: ids.length, skippedProviderManaged };
  },

  async bulkSuspendVendors(vendorIds: string[], reason?: string) {
    const vendors = await prisma.vendor.findMany({
      where: { id: { in: vendorIds }, isSuspended: false },
      select: { id: true },
    });
    if (vendors.length === 0) return { affected: 0 };
    const ids = vendors.map((v) => v.id);
    await prisma.$transaction([
      prisma.vendor.updateMany({
        where: { id: { in: ids } },
        data: { isSuspended: true, suspendedReason: reason ?? "Bulk suspended by admin" },
      }),
      prisma.product.updateMany({
        where: { vendorId: { in: ids }, isActive: true },
        data: { isActive: false },
      }),
    ]);
    return { affected: ids.length };
  },
  async suspendUser(userId: string, reason?: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError("User not found", 404);
    if (user.role === UserRole.ADMIN) throw new AppError("Admin accounts cannot be suspended here", 409);
    if (user.isSuspended) throw new AppError("User is already suspended", 409);

    return prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          isSuspended: true,
          suspendedReason: reason ?? null,
          tokenVersion: { increment: 1 },
        },
      });

      if (updatedUser.role === UserRole.VENDOR) {
        const vendor = await tx.vendor.findUnique({ where: { userId } });
        if (vendor && !vendor.isSuspended) {
          await tx.vendor.update({
            where: { id: vendor.id },
            data: {
              isSuspended: true,
              suspendedReason: reason ?? "Suspended by admin",
            },
          });
          await tx.product.updateMany({
            where: { vendorId: vendor.id, isActive: true },
            data: { isActive: false },
          });
        }
      }

      return updatedUser;
    });
  },

  async unsuspendUser(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError("User not found", 404);
    if (!user.isSuspended) throw new AppError("User is not suspended", 409);

    return prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          isSuspended: false,
          suspendedReason: null,
          tokenVersion: { increment: 1 },
        },
      });

      if (updatedUser.role === UserRole.VENDOR) {
        const vendor = await tx.vendor.findUnique({ where: { userId } });
        if (vendor?.isSuspended) {
          await tx.vendor.update({
            where: { id: vendor.id },
            data: {
              isSuspended: false,
              suspendedReason: null,
            },
          });
        }
      }

      return updatedUser;
    });
  },

  async deleteUser(userId: string, reason?: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendor: { select: { id: true } } },
    });
    if (!user) throw new AppError("User not found", 404);
    if (user.role === UserRole.ADMIN) throw new AppError("Admin accounts cannot be deleted here", 409);

    // Try a real hard delete first. Cascade relations (cart, messages,
    // notifications, push tokens, favorites, etc.) clean themselves up
    // automatically. If the user (or their vendor) has order/payment/review
    // history, Postgres will reject this with a foreign-key violation
    // (those relations are RESTRICT, not CASCADE, on purpose — financial
    // and other people's order records must never disappear). In that case
    // fall back to the existing anonymize-and-suspend behavior below.
    try {
      await prisma.user.delete({ where: { id: userId } });
      return {
        id: userId,
        email: null,
        name: null,
        role: user.role,
        isSuspended: true,
        suspendedReason: reason ?? "Deleted by admin",
        createdAt: user.createdAt,
        updatedAt: new Date(),
        hardDeleted: true,
      };
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== "P2003" && code !== "P2014") {
        throw error;
      }
      // Has order/payment/review history — cannot fully erase. Anonymize instead.
    }

    return prisma.$transaction(async (tx) => {
      await tx.pushToken.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { userId } });

      if (user.vendor?.id) {
        await tx.product.updateMany({
          where: { vendorId: user.vendor.id },
          data: { isActive: false },
        });
        await tx.vendor.update({
          where: { id: user.vendor.id },
          data: {
              isSuspended: true,
            closedAt: new Date(),
            suspendedReason: reason ?? "Deleted by admin",
            contactEmail: null,
            contactPhone: null,
            description: null,
          },
        });
      }

      const anonymized = await tx.user.update({
        where: { id: userId },
        data: {
          email: `deleted_${userId}@anonymized.local`,
          name: "Deleted user",
          phone: null,
          avatar: null,
          country: null,
          password: `deleted:${userId}`,
          anonymisedAt: new Date(),
          isSuspended: true,
          suspendedReason: reason ?? "Deleted by admin",
          tokenVersion: { increment: 1 },
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          isSuspended: true,
          suspendedReason: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return { ...anonymized, hardDeleted: false as const };
    });
  },
};
