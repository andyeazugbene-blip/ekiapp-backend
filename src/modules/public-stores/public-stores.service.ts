import crypto from "crypto";

import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { stripe } from "../../lib/stripe";
import { CURSOR_ORDER_BY, MAX_VENDOR_WEIGHT_GRAMS } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import { calculatePlatformFee as calcPlatformFee } from "../../shared/pricing";
import { otpService } from "../auth/otp.service";
import { resolveVendorCommission } from "../subscriptions/subscription-plan-utils";
import { buildVendorShareUrl } from "../vendors/vendors.service";
import type {
  ListPublicProductsQuery,
  PublicProduct,
  PublicStore,
  PublicStoreAnalyticsDetail,
  PublicStoreAnalyticsSummary,
  PublicStoreEventItemInput,
  PublicStoreEventType,
  PublicStorePromo,
  PublicStoreSourceKey,
  PublicStoreTrackedOrder,
  PublicStoreTrackedOrderStatus,
  TrackPublicStoreEventInput,
} from "./public-stores.types";

const BCRYPT_ROUNDS = 12;

const SOURCE_KEYS: PublicStoreSourceKey[] = ["instagram", "whatsapp", "sms", "direct", "tiktok", "more", "unknown"];
const TRACKABLE_ORDER_STATUSES = ["PAID", "PAYMENT_SECURED", "CONFIRMED", "VENDOR_CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT", "DELIVERED", "COMPLETED"] as const;

type VendorStoreRecord = {
  id: string;
  storeName: string;
  storeSlug: string;
  city: string | null;
  country: string | null;
  isSuspended: boolean;
};

type ParsedStoreEvent = {
  event: PublicStoreEventType;
  occurredAt: Date;
  source: PublicStoreSourceKey;
  productId?: string;
  productName?: string;
  quantity?: number;
  orderTotal?: number;
  orderIds?: string[];
  items?: PublicStoreEventItemInput[];
};

interface PublicStoreCheckoutItemInput {
  productId: string;
  quantity: number;
}

interface PublicStoreCheckoutInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  streetAddress: string;
  city: string;
  postcode: string;
  country: string;
  promoCode?: string;
  items: PublicStoreCheckoutItemInput[];
}

function normalizeStoreSlugKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeText(value: string): string {
  return value.trim();
}

function normalizeSource(value?: string): PublicStoreSourceKey {
  const input = (value ?? "").trim().toLowerCase();
  if (input.includes("instagram")) return "instagram";
  if (input.includes("whatsapp")) return "whatsapp";
  if (input === "sms" || input.includes("message")) return "sms";
  if (input.includes("tiktok")) return "tiktok";
  if (input.includes("more")) return "more";
  if (input.includes("direct") || input.includes("copy") || input.includes("link")) return "direct";
  return input ? "unknown" : "direct";
}

function buildEmptySourceMap(): Record<PublicStoreSourceKey, number> {
  return SOURCE_KEYS.reduce((acc, key) => {
    acc[key] = 0;
    return acc;
  }, {} as Record<PublicStoreSourceKey, number>);
}

function sourceLabel(source: PublicStoreSourceKey): string {
  switch (source) {
    case "instagram":
      return "Instagram";
    case "whatsapp":
      return "WhatsApp";
    case "sms":
      return "SMS";
    case "tiktok":
      return "TikTok";
    case "more":
      return "More";
    case "unknown":
      return "Unknown";
    default:
      return "Direct";
  }
}

function moneyFromCents(value: number | null | undefined): number {
  return typeof value === "number" ? value / 100 : 0;
}

function splitName(name: string | null | undefined): { firstName: string; lastName: string } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { firstName: "", lastName: "" };
  }
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

function estimatedDeliveryLabelForOrder(status: string): string {
  if (status === "DELIVERED" || status === "COMPLETED") {
    return "Delivered";
  }
  if (status === "DISPATCHED" || status === "IN_TRANSIT") {
    return "In transit";
  }
  return "2-4 days";
}

function mapOrderStatus(status: string): PublicStoreTrackedOrderStatus {
  switch (status) {
    case "CONFIRMED":
    case "VENDOR_CONFIRMED":
      return "accepted";
    case "PROCESSING":
      return "preparing";
    case "DISPATCHED":
      return "dispatched";
    case "IN_TRANSIT":
      return "in_transit";
    case "DELIVERED":
    case "COMPLETED":
      return "delivered";
    default:
      return "placed";
  }
}

function parseEventMetadata(metadata: Prisma.JsonValue | null): Omit<ParsedStoreEvent, "event" | "occurredAt"> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { source: "direct" };
  }

  const raw = metadata as Record<string, unknown>;
  const parsedItems: PublicStoreEventItemInput[] | undefined = Array.isArray(raw.items)
    ? raw.items.reduce<PublicStoreEventItemInput[]>((items, item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return items;
        }

        const entry = item as Record<string, unknown>;
        if (typeof entry.productId !== "string" || typeof entry.name !== "string") {
          return items;
        }

        items.push({
          productId: entry.productId,
          name: entry.name,
          image: typeof entry.image === "string" ? entry.image : undefined,
          quantity: typeof entry.quantity === "number" ? entry.quantity : Number(entry.quantity ?? 0),
          price: typeof entry.price === "number" ? entry.price : Number(entry.price ?? 0),
          unitLabel: typeof entry.unitLabel === "string" ? entry.unitLabel : undefined,
          etaLabel: typeof entry.etaLabel === "string" ? entry.etaLabel : undefined,
        });

        return items;
      }, [])
    : undefined;

  return {
    source: normalizeSource(typeof raw.source === "string" ? raw.source : undefined),
    productId: typeof raw.productId === "string" ? raw.productId : undefined,
    productName: typeof raw.productName === "string" ? raw.productName : undefined,
    quantity: typeof raw.quantity === "number" ? raw.quantity : raw.quantity != null ? Number(raw.quantity) : undefined,
    orderTotal: typeof raw.orderTotal === "number" ? raw.orderTotal : raw.orderTotal != null ? Number(raw.orderTotal) : undefined,
    orderIds: Array.isArray(raw.orderIds) ? raw.orderIds.filter((value): value is string => typeof value === "string") : undefined,
    items: parsedItems,
  };
}

async function findVendorBySlug(slug: string): Promise<VendorStoreRecord> {
  const exactVendor = await prisma.vendor.findUnique({
    where: { storeSlug: slug },
    select: {
      id: true,
      storeName: true,
      storeSlug: true,
      city: true,
      country: true,
      isSuspended: true,
    },
  });

  if (exactVendor?.isSuspended) {
    throw new AppError("Store not found", 404);
  }

  if (exactVendor) {
    return exactVendor;
  }

  if (typeof prisma.vendor.findMany !== "function") {
    throw new AppError("Store not found", 404);
  }

  const normalizedSlug = normalizeStoreSlugKey(slug);
  const candidates = await prisma.vendor.findMany({
    where: { isSuspended: false },
    select: {
      id: true,
      storeName: true,
      storeSlug: true,
      city: true,
      country: true,
      isSuspended: true,
    },
  });

  const matchedVendor = candidates.find((candidate) => normalizeStoreSlugKey(candidate.storeSlug) === normalizedSlug);
  if (!matchedVendor) {
    throw new AppError("Store not found", 404);
  }

  return matchedVendor;
}

async function findVendorByUserId(userId: string): Promise<VendorStoreRecord> {
  const vendor = await prisma.vendor.findUnique({
    where: { userId },
    select: {
      id: true,
      storeName: true,
      storeSlug: true,
      city: true,
      country: true,
      isSuspended: true,
    },
  });

  if (!vendor || vendor.isSuspended) {
    throw new AppError("Vendor profile not found", 404);
  }

  return vendor;
}

function buildSummary(storeSlug: string, events: ParsedStoreEvent[]): PublicStoreAnalyticsSummary {
  const summary: PublicStoreAnalyticsSummary = {
    storeSlug,
    opens: 0,
    cartAdds: 0,
    checkoutStarts: 0,
    ordersPlaced: 0,
    trackRequests: 0,
    reorders: 0,
    appLaunches: 0,
    saveVendorCount: 0,
    sourceBreakdown: buildEmptySourceMap(),
    sourceOrders: buildEmptySourceMap(),
    sourceRevenue: buildEmptySourceMap(),
  };

  for (const event of events) {
    if (event.event === "open") {
      summary.opens += 1;
      if (!summary.lastOpenedAt) {
        summary.lastOpenedAt = event.occurredAt.toISOString();
      }
      summary.sourceBreakdown[event.source] += 1;
    }
    if (event.event === "add_to_cart") summary.cartAdds += 1;
    if (event.event === "start_checkout") summary.checkoutStarts += 1;
    if (event.event === "place_order") {
      summary.ordersPlaced += 1;
      if (!summary.lastOrderAt) {
        summary.lastOrderAt = event.occurredAt.toISOString();
      }
      summary.sourceOrders[event.source] += 1;
      summary.sourceRevenue[event.source] += event.orderTotal ?? 0;
    }
    if (event.event === "track_order") summary.trackRequests += 1;
    if (event.event === "reorder") summary.reorders += 1;
    if (event.event === "open_in_app") summary.appLaunches += 1;
    if (event.event === "save_vendor") summary.saveVendorCount += 1;
  }

  return summary;
}

function parseEvents(rows: { action: string; createdAt: Date; metadata: Prisma.JsonValue | null }[]): ParsedStoreEvent[] {
  return rows
    .map((row) => {
      const action = row.action.replace(/^public_store\./, "") as PublicStoreEventType;
      if (![
        "open",
        "add_to_cart",
        "start_checkout",
        "place_order",
        "track_order",
        "reorder",
        "open_in_app",
        "save_vendor",
      ].includes(action)) {
        return null;
      }

      return {
        event: action,
        occurredAt: row.createdAt,
        ...parseEventMetadata(row.metadata),
      } satisfies ParsedStoreEvent;
    })
    .filter((event): event is ParsedStoreEvent => Boolean(event));
}

function mapTrackedOrder(
  order: {
    id: string;
    orderNumber: string;
    subtotalAmount: number;
    deliveryFeeAmount: number;
    platformFeeAmount: number;
    totalAmount: number;
    currency: string;
    createdAt: Date;
    status: string;
    deliveryAddress: string | null;
    buyer: { name: string; email: string; phone: string | null };
    items: { productId: string; productTitle: string; quantity: number; unitAmount: number; totalAmount: number }[];
  },
  vendor: VendorStoreRecord,
): PublicStoreTrackedOrder {
  const name = splitName(order.buyer.name);

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    vendorId: vendor.id,
    vendorName: vendor.storeName,
    vendorCity: vendor.city || vendor.country || "",
    vendorSlug: vendor.storeSlug,
    currency: order.currency,
    subtotal: moneyFromCents(order.subtotalAmount),
    delivery: moneyFromCents(order.deliveryFeeAmount),
    platformFee: moneyFromCents(order.platformFeeAmount),
    total: moneyFromCents(order.totalAmount),
    createdAt: order.createdAt.toISOString(),
    estimatedDeliveryLabel: estimatedDeliveryLabelForOrder(order.status),
    items: order.items.map((item) => ({
      productId: item.productId,
      name: item.productTitle,
      quantity: item.quantity,
      price: moneyFromCents(item.unitAmount),
      etaLabel: estimatedDeliveryLabelForOrder(order.status),
    })),
    contact: {
      firstName: name.firstName,
      lastName: name.lastName,
      email: order.buyer.email,
      phone: order.buyer.phone ?? "",
      addressLine1: order.deliveryAddress ?? "",
      city: "",
      postcode: "",
      country: vendor.country ?? "",
    },
    status: mapOrderStatus(order.status),
    source: "backend",
    backendOrderId: order.id,
    backendOrderIds: [order.id],
  };
}

async function listStoreEvents(vendorId: string, storeSlug: string): Promise<ParsedStoreEvent[]> {
  const rows = await prisma.auditLog.findMany({
    where: {
      actorId: vendorId,
      entityType: "PUBLIC_STORE_EVENT",
      entityId: storeSlug,
    },
    orderBy: CURSOR_ORDER_BY,
    take: 5000,
    select: {
      action: true,
      createdAt: true,
      metadata: true,
    },
  });

  return parseEvents(rows);
}

async function listTrackedOrdersForVendor(vendor: VendorStoreRecord): Promise<PublicStoreTrackedOrder[]> {
  const orders = await prisma.order.findMany({
    where: {
      vendorId: vendor.id,
      status: { in: [...TRACKABLE_ORDER_STATUSES] },
    },
    include: {
      buyer: {
        select: {
          name: true,
          email: true,
          phone: true,
          id: true,
        },
      },
      items: {
        select: {
          productId: true,
          productTitle: true,
          quantity: true,
          unitAmount: true,
          totalAmount: true,
        },
      },
    },
    orderBy: CURSOR_ORDER_BY,
  });

  return orders.map((order) => mapTrackedOrder(order, vendor));
}

async function listPublicStoreOrdersForContact(vendor: VendorStoreRecord, email: string): Promise<PublicStoreTrackedOrder[]> {
  const normalizedEmail = email.trim().toLowerCase();
  const orders = await prisma.order.findMany({
    where: {
      vendorId: vendor.id,
      status: { in: [...TRACKABLE_ORDER_STATUSES] },
      buyer: {
        email: normalizedEmail,
      },
    },
    include: {
      buyer: {
        select: {
          name: true,
          email: true,
          phone: true,
          id: true,
        },
      },
      items: {
        select: {
          productId: true,
          productTitle: true,
          quantity: true,
          unitAmount: true,
          totalAmount: true,
        },
      },
    },
    orderBy: CURSOR_ORDER_BY,
  });

  return orders.map((order) => mapTrackedOrder(order, vendor));
}

async function listPublicStoreOrdersForEmail(email: string): Promise<PublicStoreTrackedOrder[]> {
  const normalizedEmail = normalizeEmail(email);
  const orders = await prisma.order.findMany({
    where: {
      vendorId: { not: null },
      status: { in: [...TRACKABLE_ORDER_STATUSES] },
      buyer: { email: normalizedEmail },
    },
    include: {
      buyer: { select: { name: true, email: true, phone: true, id: true } },
      items: {
        select: {
          productId: true,
          productTitle: true,
          quantity: true,
          unitAmount: true,
          totalAmount: true,
        },
      },
    },
    orderBy: CURSOR_ORDER_BY,
  });

  const vendors = await prisma.vendor.findMany({
    where: {
      id: { in: orders.map((order) => order.vendorId).filter((value): value is string => Boolean(value)) },
      isSuspended: false,
    },
    select: { id: true, storeName: true, storeSlug: true, city: true, country: true, isSuspended: true },
  });
  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor]));

  return orders.flatMap((order) => {
    const vendor = order.vendorId ? vendorMap.get(order.vendorId) : undefined;
    return vendor ? [mapTrackedOrder(order, vendor)] : [];
  });
}

async function getPublicPromoForVendor(vendorId: string, code: string): Promise<PublicStorePromo & { id: string; minOrderAmount: number | null; maxUses: number | null; usedCount: number; validFrom: Date; validUntil: Date | null }> {
  const promo = await prisma.promoCode.findFirst({
    where: { vendorId, code: code.trim().toUpperCase(), isActive: true },
  });
  if (!promo) throw new AppError("Invalid promo code for this store", 400);

  const now = new Date();
  if (promo.validFrom > now) throw new AppError("Promo code is not yet active", 400);
  if (promo.validUntil && promo.validUntil < now) throw new AppError("Promo code has expired", 400);
  if (promo.maxUses && promo.usedCount >= promo.maxUses) throw new AppError("Promo code usage limit reached", 400);

  const log = await prisma.auditLog.findFirst({
    where: {
      actorId: vendorId,
      action: "vendor.promo.created",
      entityType: "PROMO_CODE",
      entityId: promo.id,
    },
    orderBy: CURSOR_ORDER_BY,
    select: { metadata: true },
  });
  const metadata = log?.metadata && typeof log.metadata === "object" && !Array.isArray(log.metadata)
    ? log.metadata as Record<string, unknown>
    : {};
  const productIds = Array.isArray(metadata.productIds)
    ? metadata.productIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  return {
    id: promo.id,
    code: promo.code,
    type: promo.type,
    value: promo.value,
    productIds,
    appliesToAllProducts: productIds.length === 0,
    minOrderAmount: promo.minOrderAmount,
    maxUses: promo.maxUses,
    usedCount: promo.usedCount,
    validFrom: promo.validFrom,
    validUntil: promo.validUntil,
  };
}

async function findPublicProductForVendor(vendorId: string, productId: string): Promise<PublicProduct> {
  const product = await prisma.product.findFirst({
    where: {
      id: productId,
      vendorId,
      isActive: true,
    },
    select: {
      id: true,
      vendorId: true,
      title: true,
      description: true,
      priceInCents: true,
      currency: true,
      images: true,
      category: true,
      stock: true,
      weightGrams: true,
      createdAt: true,
    },
  });

  if (!product) {
    throw new AppError("Product not found", 404);
  }

  return product;
}

async function findTrackedOrderByNumber(vendor: VendorStoreRecord, orderNumber: string): Promise<PublicStoreTrackedOrder> {
  const order = await prisma.order.findFirst({
    where: {
      vendorId: vendor.id,
      orderNumber,
    },
    include: {
      buyer: {
        select: {
          name: true,
          email: true,
          phone: true,
          id: true,
        },
      },
      items: {
        select: {
          productId: true,
          productTitle: true,
          quantity: true,
          unitAmount: true,
          totalAmount: true,
        },
      },
    },
  });

  if (!order) {
    throw new AppError("Order not found", 404);
  }

  return mapTrackedOrder(order, vendor);
}

async function ensureGuestBuyer(input: PublicStoreCheckoutInput) {
  const email = normalizeEmail(input.email);
  const phone = normalizeText(input.phone);
  const name = `${normalizeText(input.firstName)} ${normalizeText(input.lastName)}`.trim() || email.split("@")[0] || "Guest buyer";

  const existing = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      phone: true,
      country: true,
      role: true,
    },
  });

  if (existing) {
    if (!existing.phone && phone) {
      const phoneConflict = await prisma.user.findFirst({
        where: { phone, NOT: { id: existing.id } },
        select: { id: true },
      });

      if (!phoneConflict) {
        await prisma.user.update({
          where: { id: existing.id },
          data: {
            phone,
            country: existing.country ?? normalizeText(input.country),
            name: existing.name || name,
          },
        });
      }
    }

    return { id: existing.id, email };
  }

  const password = crypto.randomBytes(24).toString("hex");
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const phoneConflict = phone
    ? await prisma.user.findFirst({
        where: { phone },
        select: { id: true },
      })
    : null;

  const created = await prisma.user.create({
    data: {
      email,
      name,
      password: passwordHash,
      phone: phoneConflict ? null : phone || null,
      country: normalizeText(input.country) || null,
      role: "BUYER",
    },
    select: { id: true, email: true },
  });

  return created;
}

export const publicStoresService = {
  async listPublicStores(limit = 48): Promise<PublicStore[]> {
    const vendors = await prisma.vendor.findMany({
      where: {
        isSuspended: false,
      },
      orderBy: [{ verificationStatus: "asc" }, { createdAt: "desc" }],
      take: limit,
      select: {
        id: true,
        storeName: true,
        storeSlug: true,
        description: true,
        avatar: true,
        coverImage: true,
        city: true,
        country: true,
        verificationStatus: true,
        createdAt: true,
      },
    });

    const stores = await Promise.all(
      vendors.map(async (vendor) => {
        const [totalProducts, deliveryZones] = await Promise.all([
          prisma.product.count({
            where: { vendorId: vendor.id, isActive: true },
          }),
          prisma.deliveryZone.findMany({
            where: { vendorId: vendor.id, isActive: true },
            select: { country: true },
            distinct: ["country"],
          }),
        ]);

        return {
          vendorId: vendor.id,
          storeName: vendor.storeName,
          storeSlug: vendor.storeSlug,
          shareUrl: buildVendorShareUrl(vendor.storeSlug),
          description: vendor.description,
          avatar: vendor.avatar,
          coverImage: vendor.coverImage,
          city: vendor.city,
          country: vendor.country,
          verificationStatus: vendor.verificationStatus,
          rating: null,
          totalProducts,
          deliveryCountries: deliveryZones
            .map((zone) => zone.country)
            .filter((country): country is string => Boolean(country)),
          createdAt: vendor.createdAt,
        } satisfies PublicStore;
      }),
    );

    return stores;
  },

  async getStoreBySlug(slug: string): Promise<PublicStore> {
    const vendorRecord = await findVendorBySlug(slug);
    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorRecord.id },
      select: {
        id: true,
        storeName: true,
        storeSlug: true,
        description: true,
        avatar: true,
        coverImage: true,
        city: true,
        country: true,
        verificationStatus: true,
        isSuspended: true,
        createdAt: true,
      },
    });

    if (!vendor || vendor.isSuspended) {
      throw new AppError("Store not found", 404);
    }

    const [totalProducts, deliveryZones] = await Promise.all([
      prisma.product.count({
        where: { vendorId: vendor.id, isActive: true },
      }),
      prisma.deliveryZone.findMany({
        where: { vendorId: vendor.id, isActive: true },
        select: { country: true },
        distinct: ["country"],
      }),
    ]);

    const deliveryCountries = deliveryZones
      .map((zone) => zone.country)
      .filter((country): country is string => Boolean(country));

    return {
      vendorId: vendor.id,
      storeName: vendor.storeName,
      storeSlug: vendor.storeSlug,
      shareUrl: buildVendorShareUrl(vendor.storeSlug),
      description: vendor.description,
      avatar: vendor.avatar,
      coverImage: vendor.coverImage,
      city: vendor.city,
      country: vendor.country,
      verificationStatus: vendor.verificationStatus,
      rating: null,
      totalProducts,
      deliveryCountries,
      createdAt: vendor.createdAt,
    };
  },

  async listStoreProducts(
    slug: string,
    query: ListPublicProductsQuery,
  ): Promise<{ items: PublicProduct[]; nextCursor: string | null }> {
    const vendor = await findVendorBySlug(slug);

    const items = await prisma.product.findMany({
      where: {
        vendorId: vendor.id,
        isActive: true,
        ...(query.category ? { category: query.category } : {}),
      },
      orderBy: CURSOR_ORDER_BY,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        vendorId: true,
        title: true,
        description: true,
        priceInCents: true,
        currency: true,
        images: true,
        category: true,
        stock: true,
        weightGrams: true,
        createdAt: true,
      },
    });

    let nextCursor: string | null = null;
    if (items.length > query.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    return { items, nextCursor };
  },

  async getStoreProductById(slug: string, productId: string): Promise<PublicProduct> {
    const vendor = await findVendorBySlug(slug);
    return findPublicProductForVendor(vendor.id, productId);
  },

  async getPublicPromo(slug: string, code: string): Promise<PublicStorePromo> {
    const vendor = await findVendorBySlug(slug);
    const promo = await getPublicPromoForVendor(vendor.id, code);
    return {
      code: promo.code,
      type: promo.type,
      value: promo.value,
      productIds: promo.productIds,
      appliesToAllProducts: promo.appliesToAllProducts,
    };
  },

  async createGuestCheckoutSession(
    slug: string,
    input: PublicStoreCheckoutInput,
  ): Promise<{ checkoutUrl: string; orderNumber: string; checkoutId: string }> {
    const vendor = await findVendorBySlug(slug);
    const itemsInput = input.items
      .map((item) => ({
        productId: normalizeText(item.productId),
        quantity: Number(item.quantity),
      }))
      .filter((item) => item.productId && Number.isInteger(item.quantity) && item.quantity > 0);

    if (itemsInput.length === 0) {
      throw new AppError("Your cart is empty", 400);
    }

    const products = await prisma.product.findMany({
      where: {
        vendorId: vendor.id,
        isActive: true,
        id: { in: itemsInput.map((item) => item.productId) },
      },
      select: {
        id: true,
        vendorId: true,
        title: true,
        priceInCents: true,
        costAmount: true,
        costCurrency: true,
        currency: true,
        stock: true,
        weightGrams: true,
      },
    });

    if (products.length !== itemsInput.length) {
      throw new AppError("Some products are no longer available", 400);
    }

    const productMap = new Map(products.map((product) => [product.id, product]));
    const currencySet = new Set(products.map((product) => product.currency.toLowerCase()));
    if (currencySet.size !== 1) {
      throw new AppError("All products in this checkout must use the same currency", 400);
    }
    const currency = products[0]?.currency.toLowerCase() ?? "eur";

    const normalizedCountry = normalizeText(input.country);
    if (!normalizedCountry) {
      throw new AppError("Delivery country is required", 400);
    }

    const baseZone = await prisma.deliveryZone.findFirst({
      where: {
        vendorId: vendor.id,
        country: { equals: normalizedCountry, mode: "insensitive" },
        isActive: true,
      },
    });

    if (!baseZone) {
      throw new AppError(`Delivery to "${normalizedCountry}" is not available`, 400);
    }

    if (baseZone.currency.toLowerCase() !== currency) {
      throw new AppError("Delivery zone currency mismatch", 400);
    }

    const pricedItems = itemsInput.map((item) => {
      const product = productMap.get(item.productId);
      if (!product) {
        throw new AppError("Some products are no longer available", 400);
      }
      if (product.stock < item.quantity) {
        throw new AppError(`Insufficient stock for "${product.title}"`, 409);
      }
      return {
        productId: product.id,
        vendorId: product.vendorId,
        productTitle: product.title,
        quantity: item.quantity,
        unitAmount: product.priceInCents,
        totalAmount: product.priceInCents * item.quantity,
        costAmount: product.costAmount,
        costCurrency: product.costCurrency ?? product.currency,
        currency: product.currency,
        weightGrams: (product.weightGrams ?? 0) * item.quantity,
      };
    });

    const originalSubtotalAmount = pricedItems.reduce((sum, item) => sum + item.totalAmount, 0);
    const totalWeight = pricedItems.reduce((sum, item) => sum + item.weightGrams, 0);
    if (totalWeight > MAX_VENDOR_WEIGHT_GRAMS) {
      throw new AppError(
        `Order weight exceeds the maximum of ${MAX_VENDOR_WEIGHT_GRAMS / 1000}kg. Please reduce items.`,
        400,
      );
    }

    const deliveryFeeAmount = baseZone.baseFeeAmount + Math.ceil(totalWeight / 1000) * baseZone.feePerKgAmount;
    const buyer = await ensureGuestBuyer(input);
    const promo = input.promoCode ? await getPublicPromoForVendor(vendor.id, input.promoCode) : null;
    const eligibleProductIds = new Set(promo?.productIds ?? []);
    const eligibleSubtotalAmount = promo
      ? pricedItems
          .filter((item) => promo.appliesToAllProducts || eligibleProductIds.has(item.productId))
          .reduce((sum, item) => sum + item.totalAmount, 0)
      : 0;

    if (promo && eligibleSubtotalAmount <= 0) {
      throw new AppError("This coupon does not apply to the products in your cart", 400);
    }
    if (promo?.minOrderAmount && eligibleSubtotalAmount < promo.minOrderAmount) {
      throw new AppError(`Minimum eligible order amount is ${promo.minOrderAmount} cents`, 400);
    }
    if (promo) {
      const previousRedemption = await prisma.promoRedemption.findUnique({
        where: { promoCodeId_buyerId: { promoCodeId: promo.id, buyerId: buyer.id } },
        select: { id: true },
      });
      if (previousRedemption) {
        throw new AppError("You have already used this promo code", 400);
      }
    }

    const discountAmount = promo
      ? promo.type === "PERCENTAGE"
        ? Math.round((eligibleSubtotalAmount * promo.value) / 100)
        : Math.min(promo.value, eligibleSubtotalAmount)
      : 0;
    const subtotalAmount = Math.max(0, originalSubtotalAmount - discountAmount);
    const commission = await resolveVendorCommission(vendor.id, subtotalAmount);
    const platformFeeAmount = calcPlatformFee(subtotalAmount, commission.platformFeeBps);
    const totalAmount = subtotalAmount + deliveryFeeAmount;
    const vendorEarningsAmount = totalAmount - platformFeeAmount;
    if (totalAmount <= 0) {
      throw new AppError("The checkout total must be greater than zero", 400);
    }
    const deliveryAddress = [normalizeText(input.streetAddress), normalizeText(input.city), normalizeText(input.postcode), normalizedCountry]
      .filter(Boolean)
      .join(", ");

    let remainingDiscount = discountAmount;
    const discountedLineItems = pricedItems.map((item, index) => {
      const eligible = Boolean(promo && (promo.appliesToAllProducts || eligibleProductIds.has(item.productId)));
      const laterEligible = pricedItems.slice(index + 1).some((entry) => promo && (promo.appliesToAllProducts || eligibleProductIds.has(entry.productId)));
      const itemDiscount = eligible
        ? Math.min(
            item.totalAmount,
            laterEligible
              ? Math.round((discountAmount * item.totalAmount) / Math.max(1, eligibleSubtotalAmount))
              : remainingDiscount,
          )
        : 0;
      remainingDiscount = Math.max(0, remainingDiscount - itemDiscount);
      return { ...item, checkoutAmount: Math.max(0, item.totalAmount - itemDiscount), itemDiscount };
    });

    const { checkoutId, orderId, orderNumber } = await prisma.$transaction(async (tx) => {
      for (const item of pricedItems) {
        const updated = await tx.product.updateMany({
          where: { id: item.productId, vendorId: vendor.id, isActive: true, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        });
        if (updated.count !== 1) {
          throw new AppError(`Insufficient stock for "${item.productTitle}"`, 409);
        }
      }

      const checkout = await tx.checkout.create({
        data: {
          buyerId: buyer.id,
          totalAmount,
          currency,
          status: "PENDING",
          metadata: {
            source: "public_store",
            storeSlug: vendor.storeSlug,
            buyerEmail: buyer.email,
            buyerPhone: normalizeText(input.phone),
            deliveryAddress,
            deliveryCountry: normalizedCountry,
            originalSubtotalAmount,
            discountAmount,
            promoCode: promo?.code ?? null,
            sellerPlanId: commission.sellerPlanId,
            sellerPlanSlug: commission.sellerPlanSlug,
            commissionTierId: commission.commissionTierId,
            commissionBps: commission.platformFeeBps,
            withdrawalFeeBps: commission.withdrawalFeeBps,
          } as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      const orderNumber = `EKI-${new Date().getFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
      const order = await tx.order.create({
        data: {
          checkoutId: checkout.id,
          buyerId: buyer.id,
          vendorId: vendor.id,
          orderNumber,
          status: "PENDING",
          subtotalAmount,
          deliveryFeeAmount,
          platformFeeAmount,
          vendorEarnings: vendorEarningsAmount,
          sellerPlanId: commission.sellerPlanId,
          sellerPlanSlug: commission.sellerPlanSlug,
          commissionTierId: commission.commissionTierId,
          commissionBps: commission.platformFeeBps,
          withdrawalFeeBps: commission.withdrawalFeeBps,
          totalAmount,
          currency,
          deliveryZoneId: baseZone.id,
          deliveryAddress,
        },
        select: { id: true, orderNumber: true },
      });

      await tx.orderItem.createMany({
        data: pricedItems.map((item) => ({
          orderId: order.id,
          productId: item.productId,
          vendorId: vendor.id,
          quantity: item.quantity,
          unitAmount: item.unitAmount,
          totalAmount: item.totalAmount,
          costAmount: item.costAmount,
          costCurrency: item.costCurrency,
          currency: item.currency,
          productTitle: item.productTitle,
        })),
      });

      await tx.payment.create({
        data: {
          orderId: order.id,
          amount: totalAmount,
          platformFeeAmount,
          vendorEarningsAmount,
          sellerPlanId: commission.sellerPlanId,
          sellerPlanSlug: commission.sellerPlanSlug,
          commissionTierId: commission.commissionTierId,
          commissionBps: commission.platformFeeBps,
          withdrawalFeeBps: commission.withdrawalFeeBps,
          currency,
          status: "PENDING",
          provider: "stripe",
        },
      });

      if (promo && discountAmount > 0) {
        const updated = await tx.promoCode.updateMany({
          where: {
            id: promo.id,
            vendorId: vendor.id,
            isActive: true,
            ...(promo.maxUses ? { usedCount: { lt: promo.maxUses } } : {}),
          },
          data: { usedCount: { increment: 1 } },
        });
        if (updated.count !== 1) {
          throw new AppError("Promo no longer available", 409);
        }
        await tx.promoRedemption.create({
          data: {
            promoCodeId: promo.id,
            buyerId: buyer.id,
            orderId: order.id,
            discountAmount,
          },
        });
      }

      return { checkoutId: checkout.id, orderId: order.id, orderNumber: order.orderNumber };
    }, { isolationLevel: "Serializable" });

    const publicBaseUrl = process.env.FRONTEND_URL ?? "https://www.culinarytales.app";

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: normalizeEmail(input.email),
        success_url: `${publicBaseUrl}/store/${vendor.storeSlug}/confirmed?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${publicBaseUrl}/store/${vendor.storeSlug}/checkout?cancelled=true`,
        metadata: {
          kind: "public_store_checkout",
          checkoutId,
          buyerId: buyer.id,
          orderIds: orderId,
          vendorIds: vendor.id,
          orderNumber,
          storeSlug: vendor.storeSlug,
          walletDeduction: "0",
          promoCode: promo?.code ?? "",
          discountAmount: String(discountAmount),
        },
        payment_intent_data: {
          metadata: {
            kind: "public_store_checkout",
            checkoutId,
            buyerId: buyer.id,
            orderIds: orderId,
            vendorIds: vendor.id,
            orderNumber,
            storeSlug: vendor.storeSlug,
            walletDeduction: "0",
            promoCode: promo?.code ?? "",
            discountAmount: String(discountAmount),
          },
        },
        line_items: [
          ...discountedLineItems.filter((item) => item.checkoutAmount > 0).map((item) => ({
            quantity: 1,
            price_data: {
              currency,
              unit_amount: item.checkoutAmount,
              product_data: {
                name: `${item.productTitle} x ${item.quantity}`,
                metadata: { productId: item.productId, promoDiscount: String(item.itemDiscount) },
              },
            },
          })),
          ...(deliveryFeeAmount > 0
            ? [{
                quantity: 1,
                price_data: {
                  currency,
                  unit_amount: deliveryFeeAmount,
                  product_data: {
                    name: "Delivery",
                    description: normalizedCountry,
                  },
                },
              }]
            : []),
        ],
      });

      if (!session.url) {
        throw new AppError("Could not create checkout session", 502);
      }
    } catch (stripeError) {
      const stripeErr = stripeError as { type?: string; code?: string; message?: string; statusCode?: number };
      logger.error("Stripe checkout session creation failed", {
        storeSlug: slug,
        checkoutId,
        errorMessage: stripeErr.message ?? String(stripeError),
        stripeType: stripeErr.type,
        stripeCode: stripeErr.code,
      });
      if (stripeErr.type === "StripeCardError") {
        throw new AppError(stripeErr.message ?? "Card declined", 400);
      }
      if (stripeErr.type === "StripeInvalidRequestError") {
        throw new AppError(stripeErr.message ?? "Payment request invalid", 400);
      }
      if (stripeErr.type === "StripeAuthenticationError") {
        throw new AppError(`Stripe auth error: ${stripeErr.message ?? "Invalid key"}`, 502);
      }
      // TEMP: surface the raw Stripe error for debugging
      throw new AppError(`Stripe: ${stripeErr.message ?? String(stripeError)}`, 502);
    }

    return {
      checkoutUrl: session!.url,
      orderNumber,
      checkoutId,
    };
  },

  async getStoreOrderByNumber(slug: string, orderNumber: string): Promise<PublicStoreTrackedOrder> {
    const vendor = await findVendorBySlug(slug);
    return findTrackedOrderByNumber(vendor, orderNumber);
  },

  async getStoreOrderByCheckoutSession(slug: string, sessionId: string): Promise<PublicStoreTrackedOrder> {
    const vendor = await findVendorBySlug(slug);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const orderNumber = session.metadata?.orderNumber;
    if (!orderNumber) {
      throw new AppError("Order not found", 404);
    }
    return findTrackedOrderByNumber(vendor, orderNumber);
  },

  async recordEvent(slug: string, input: TrackPublicStoreEventInput, viewerId?: string): Promise<PublicStoreAnalyticsSummary> {
    const vendor = await findVendorBySlug(slug);
    const source = normalizeSource(input.source);

    await prisma.auditLog.create({
      data: {
        actorId: vendor.id,
        action: `public_store.${input.event}`,
        entityType: "PUBLIC_STORE_EVENT",
        entityId: vendor.storeSlug,
        metadata: {
          source,
          productId: input.productId,
          productName: input.productName,
          quantity: input.quantity,
          orderTotal: input.orderTotal,
          orderIds: input.orderIds,
          items: input.items,
          viewerId: viewerId ?? null,
        } as Prisma.InputJsonValue,
      },
    });

    return this.getAnalyticsSummaryForVendor(vendor.id, vendor.storeSlug);
  },

  async getAnalyticsSummaryForVendor(vendorId: string, storeSlug: string): Promise<PublicStoreAnalyticsSummary> {
    const events = await listStoreEvents(vendorId, storeSlug);
    return buildSummary(storeSlug, events);
  },

  async getDetailedAnalyticsForUser(userId: string, requestedStoreSlug?: string): Promise<PublicStoreAnalyticsDetail> {
    const vendor = await findVendorByUserId(userId);
    if (
      requestedStoreSlug &&
      normalizeStoreSlugKey(requestedStoreSlug) !== normalizeStoreSlugKey(vendor.storeSlug)
    ) {
      throw new AppError("Store not found", 404);
    }

    const [events, orders] = await Promise.all([
      listStoreEvents(vendor.id, vendor.storeSlug),
      listTrackedOrdersForVendor(vendor),
    ]);

    const summary = buildSummary(vendor.storeSlug, events);
    const weekCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const weeklyEvents = events.filter((event) => event.occurredAt.getTime() >= weekCutoff);
    const weeklyOpens = weeklyEvents.filter((event) => event.event === "open").length;
    const weeklyOrders = weeklyEvents.filter((event) => event.event === "place_order").length;

    const trackedOrderIds = new Set(
      events
        .filter((event) => event.event === "place_order")
        .flatMap((event) => event.orderIds ?? [])
        .filter(Boolean),
    );

    const publicStoreOrders = trackedOrderIds.size > 0
      ? orders.filter((order) => trackedOrderIds.has(order.id))
      : [];

    const totalRevenue = publicStoreOrders.reduce((sum, order) => sum + order.total, 0);
    const pendingRevenue = publicStoreOrders
      .filter((order) => order.status !== "delivered")
      .reduce((sum, order) => sum + order.total, 0);
    const completedOrders = publicStoreOrders.filter((order) => order.status === "delivered").length;

    const ordersByBuyer = new Map<string, PublicStoreTrackedOrder[]>();
    for (const order of publicStoreOrders) {
      const key = order.contact.email.trim().toLowerCase() || order.id;
      const existing = ordersByBuyer.get(key) ?? [];
      existing.push(order);
      ordersByBuyer.set(key, existing);
    }

    let repeatRevenue = 0;
    for (const buyerOrders of ordersByBuyer.values()) {
      buyerOrders
        .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
        .slice(1)
        .forEach((order) => {
          repeatRevenue += order.total;
        });
    }

    const productMap = new Map<string, { productId: string; name: string; cartAdds: number; unitsSold: number; revenue: number }>();

    for (const event of events) {
      if (event.event === "add_to_cart" && event.productId) {
        const current = productMap.get(event.productId) ?? {
          productId: event.productId,
          name: event.productName ?? "Product",
          cartAdds: 0,
          unitsSold: 0,
          revenue: 0,
        };
        current.cartAdds += event.quantity ?? 1;
        productMap.set(event.productId, current);
      }

      if (event.event === "place_order" && Array.isArray(event.items)) {
        for (const item of event.items) {
          const current = productMap.get(item.productId) ?? {
            productId: item.productId,
            name: item.name,
            cartAdds: 0,
            unitsSold: 0,
            revenue: 0,
          };
          current.unitsSold += item.quantity;
          current.revenue += item.price * item.quantity;
          productMap.set(item.productId, current);
        }
      }
    }

    for (const order of publicStoreOrders) {
      for (const item of order.items) {
        const current = productMap.get(item.productId) ?? {
          productId: item.productId,
          name: item.name,
          cartAdds: 0,
          unitsSold: 0,
          revenue: 0,
        };
        current.unitsSold += item.quantity;
        current.revenue += item.price * item.quantity;
        productMap.set(item.productId, current);
      }
    }

    const topProducts = Array.from(productMap.values())
      .sort((left, right) => right.unitsSold - left.unitsSold || right.revenue - left.revenue || right.cartAdds - left.cartAdds)
      .slice(0, 6);

    const sourcePerformance = SOURCE_KEYS.filter((source) => {
      const clicks = summary.sourceBreakdown[source] ?? 0;
      const ordersPlaced = summary.sourceOrders[source] ?? 0;
      const revenue = summary.sourceRevenue[source] ?? 0;
      return clicks > 0 || ordersPlaced > 0 || revenue > 0 || source === "direct";
    }).map((source) => ({
      source,
      label: sourceLabel(source),
      clicks: summary.sourceBreakdown[source] ?? 0,
      orders: summary.sourceOrders[source] ?? 0,
      revenue: summary.sourceRevenue[source] ?? 0,
    }));

    return {
      ...summary,
      weeklyOpens,
      weeklyOrders,
      conversionRate: summary.opens > 0 ? (summary.ordersPlaced / summary.opens) * 100 : 0,
      totalRevenue,
      pendingRevenue,
      completedOrders,
      repeatRevenue,
      sourcePerformance,
      topProducts,
    };
  },

  async requestGuestOrderLookupCode(slug: string, email: string): Promise<void> {
    const vendor = await findVendorBySlug(slug);
    const normalizedEmail = email.trim().toLowerCase();

    const existingOrder = await prisma.order.findFirst({
      where: {
        vendorId: vendor.id,
        status: { in: [...TRACKABLE_ORDER_STATUSES] },
        buyer: {
          email: normalizedEmail,
        },
      },
      select: { id: true },
    });

    if (!existingOrder) {
      return;
    }

    await otpService.sendOtp(normalizedEmail, "guest_order_lookup");
  },

  async requestGuestOrderLookupCodeByEmail(email: string): Promise<boolean> {
    const normalizedEmail = normalizeEmail(email);
    const existingOrder = await prisma.order.findFirst({
      where: {
        vendorId: { not: null },
        status: { in: [...TRACKABLE_ORDER_STATUSES] },
        buyer: { email: normalizedEmail },
      },
      select: { id: true },
    });
    if (!existingOrder) return false;
    await otpService.sendOtp(normalizedEmail, "guest_order_lookup");
    return true;
  },

  async verifyGuestOrderLookup(slug: string, email: string, code: string): Promise<PublicStoreTrackedOrder[]> {
    const vendor = await findVendorBySlug(slug);
    const normalizedEmail = email.trim().toLowerCase();

    await otpService.verifyOtp(normalizedEmail, code, "guest_order_lookup");
    return listPublicStoreOrdersForContact(vendor, normalizedEmail);
  },

  async verifyGuestOrderLookupByEmail(email: string, code: string): Promise<PublicStoreTrackedOrder[]> {
    const normalizedEmail = normalizeEmail(email);
    await otpService.verifyOtp(normalizedEmail, code, "guest_order_lookup");
    return listPublicStoreOrdersForEmail(normalizedEmail);
  },
};
