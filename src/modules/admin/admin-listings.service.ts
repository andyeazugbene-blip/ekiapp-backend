import {
  OrderStatus,
  PaymentStatus,
  UserRole,
  VendorVerificationStatus,
  WalletTransactionType,
} from "@prisma/client";

import { prisma } from "../../lib/prisma";
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
  if (typeof value !== "string" || !(value in allowed)) {
    throw new AppError(`Invalid ${field}`, 400);
  }
  return allowed[value as keyof typeof allowed];
}

async function paginate<TWhere, TItem extends { id: string }>(
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
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { createdAt: "desc" },
          take,
          cursor,
          skip,
        }),
      pagination,
    );
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
          orderBy: { createdAt: "desc" },
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

    return paginate(
      ({ take, cursor, skip }) =>
        prisma.product.findMany({
          where: isActive === undefined ? {} : { isActive },
          orderBy: { createdAt: "desc" },
          take,
          cursor,
          skip,
        }),
      pagination,
    );
  },

  async listOrders(query: Record<string, unknown>) {
    const status = optionalEnum(query.status, OrderStatus, "status");
    const pagination = parsePagination(query);

    return paginate(
      ({ take, cursor, skip }) =>
        prisma.order.findMany({
          where: status ? { status } : {},
          include: {
            items: true,
            payment: { select: { id: true, status: true, stripePaymentIntentId: true } },
          },
          orderBy: { createdAt: "desc" },
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

    return paginate(
      ({ take, cursor, skip }) =>
        prisma.payment.findMany({
          where: status ? { status } : {},
          orderBy: { createdAt: "desc" },
          take,
          cursor,
          skip,
        }),
      pagination,
    );
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
          orderBy: { createdAt: "desc" },
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
};
