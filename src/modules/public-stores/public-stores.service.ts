import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import { otpService } from "../auth/otp.service";
import { buildVendorShareUrl } from "../vendors/vendors.service";
import type {
  ListPublicProductsQuery,
  PublicProduct,
  PublicStore,
  PublicStoreAnalyticsDetail,
  PublicStoreAnalyticsSummary,
  PublicStoreEventItemInput,
  PublicStoreEventType,
  PublicStoreSourceKey,
  PublicStoreTrackedOrder,
  PublicStoreTrackedOrderStatus,
  TrackPublicStoreEventInput,
} from "./public-stores.types";

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

function normalizeStoreSlugKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
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

export const publicStoresService = {
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

  async verifyGuestOrderLookup(slug: string, email: string, code: string): Promise<PublicStoreTrackedOrder[]> {
    const vendor = await findVendorBySlug(slug);
    const normalizedEmail = email.trim().toLowerCase();

    await otpService.verifyOtp(normalizedEmail, code, "guest_order_lookup");
    return listPublicStoreOrdersForContact(vendor, normalizedEmail);
  },
};
