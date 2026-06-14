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

export const adminListingsService = {
  async listUsers(query: Record<string, unknown>) {
    const role = optionalEnum(query.role, UserRole, "role");
    const pagination = parsePagination(query);

    return paginate(
      ({ take, cursor, skip }) =>
        prisma.user.findMany({
          where: role ? { role } : {},
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
          orderBy: CURSOR_ORDER_BY,
          take,
          cursor,
          skip,
        }),
      pagination,
    );
  },

  async getUser(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
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
    if (!user) throw new AppError("User not found", 404);
    return user;
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

    const [products, recentOrders, reviewAgg, totalRevenue] = await Promise.all([
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
    ]);

    return {
      ...vendor,
      products,
      recentOrders,
      avgRating: reviewAgg._avg.rating,
      totalReviews: reviewAgg._count,
      totalRevenue: totalRevenue._sum.totalAmount ?? 0,
    };
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
    return { ...order, vendorName: vInfo?.storeName ?? null, vendorInfo: vInfo };
  },

  async listVendors(query: Record<string, unknown>) {
    const verificationStatus = optionalEnum(
      query.status,
      VendorVerificationStatus,
      "status",
    );
    const pagination = parsePagination(query);

    return paginate(
      ({ take, cursor, skip }) =>
        prisma.vendor.findMany({
          where: verificationStatus ? { verificationStatus } : {},
          include: {
            user: { select: { id: true, email: true, name: true, role: true } },
          },
          orderBy: CURSOR_ORDER_BY,
          take,
          cursor,
          skip,
        }),
      pagination,
    );
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

    return paginate(
      ({ take, cursor, skip }) =>
        prisma.order.findMany({
          where: status ? { status } : {},
          include: {
            items: { select: { id: true, productTitle: true, quantity: true, unitAmount: true, totalAmount: true } },
            payment: { select: { id: true, status: true, stripePaymentIntentId: true, provider: true, amount: true, platformFeeAmount: true, vendorEarningsAmount: true, currency: true } },
            buyer: { select: { id: true, name: true, email: true } },
          },
          orderBy: CURSOR_ORDER_BY,
          take,
          cursor,
          skip,
        }),
      pagination,
    );
  },

  async listPayments(query: Record<string, unknown>) {
    const status = optionalEnum(query.status, PaymentStatus, "status");
    const pagination = parsePagination(query);

    const { items, nextCursor } = await paginate(
      ({ take, cursor, skip }) =>
        prisma.payment.findMany({
          where: status ? { status } : {},
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
    );

    // Enrich with vendor store names (Order has vendorId as plain field, no relation)
    const vids = [...new Set(items.map((p: any) => p.order?.vendorId).filter(Boolean))] as string[];
    if (vids.length > 0) {
      const vendors = await prisma.vendor.findMany({ where: { id: { in: vids } }, select: { id: true, storeName: true } });
      const vm = new Map(vendors.map((v) => [v.id, v.storeName]));
      for (const p of items as any[]) { if (p.order?.vendorId) p.vendorName = vm.get(p.order.vendorId) ?? null; }
    }

    return { items, nextCursor };
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

  async approveVendor(vendorId: string) {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new AppError("Vendor not found", 404);
    return prisma.vendor.update({
      where: { id: vendorId },
      data: { verificationStatus: VendorVerificationStatus.VERIFIED },
    });
  },

  async rejectVendor(vendorId: string) {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new AppError("Vendor not found", 404);
    return prisma.vendor.update({
      where: { id: vendorId },
      data: { verificationStatus: VendorVerificationStatus.REJECTED },
    });
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
    return { ...payment, vendorName };
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
            suspendedReason: reason ?? "Deleted by admin",
            contactEmail: null,
            contactPhone: null,
            description: null,
          },
        });
      }

      return tx.user.update({
        where: { id: userId },
        data: {
          email: `deleted_${userId}@anonymized.local`,
          name: "Deleted user",
          phone: null,
          avatar: null,
          country: null,
          password: `deleted:${userId}`,
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
    });
  },
};

