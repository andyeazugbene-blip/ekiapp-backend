/**
 * Shape of a publicly-exposed vendor storefront. Strictly excludes any
 * private/PII data: no email, phone, wallet, payouts, KYC documents, Stripe
 * account details, internal user data, or admin metadata.
 */
export interface PublicStore {
  vendorId: string;
  storeName: string;
  storeSlug: string;
  shareUrl: string;
  description: string | null;
  avatar: string | null;
  coverImage: string | null;
  city: string | null;
  country: string | null;
  verificationStatus: "PENDING" | "VERIFIED" | "REJECTED";
  rating: number | null;
  totalProducts: number;
  deliveryCountries: string[];
  createdAt: Date;
}

/**
 * Public product shape — same fields as Product but stripped of any internal
 * vendor relations / cost data we don't want to expose.
 */
export interface PublicProduct {
  id: string;
  vendorId: string;
  title: string;
  description: string | null;
  priceInCents: number;
  currency: string;
  images: string[];
  category: string | null;
  stock: number;
  weightGrams: number | null;
  createdAt: Date;
}

export interface ListPublicProductsQuery {
  limit: number;
  cursor?: string;
  category?: string;
}

export type PublicStoreSourceKey = "instagram" | "whatsapp" | "sms" | "direct" | "tiktok" | "more" | "unknown";

export type PublicStoreEventType =
  | "open"
  | "add_to_cart"
  | "start_checkout"
  | "place_order"
  | "track_order"
  | "reorder"
  | "open_in_app"
  | "save_vendor";

export interface PublicStoreEventItemInput {
  productId: string;
  name: string;
  image?: string;
  quantity: number;
  price: number;
  unitLabel?: string;
  etaLabel?: string;
}

export interface TrackPublicStoreEventInput {
  event: PublicStoreEventType;
  source?: string;
  productId?: string;
  productName?: string;
  quantity?: number;
  orderTotal?: number;
  orderIds?: string[];
  items?: PublicStoreEventItemInput[];
}

export interface PublicStoreAnalyticsSummary {
  storeSlug: string;
  opens: number;
  cartAdds: number;
  checkoutStarts: number;
  ordersPlaced: number;
  trackRequests: number;
  reorders: number;
  appLaunches: number;
  saveVendorCount: number;
  sourceBreakdown: Record<PublicStoreSourceKey, number>;
  sourceOrders: Record<PublicStoreSourceKey, number>;
  sourceRevenue: Record<PublicStoreSourceKey, number>;
  lastOpenedAt?: string;
  lastOrderAt?: string;
}

export interface PublicStoreSourcePerformance {
  source: PublicStoreSourceKey;
  label: string;
  clicks: number;
  orders: number;
  revenue: number;
}

export interface PublicStoreTopProduct {
  productId: string;
  name: string;
  cartAdds: number;
  unitsSold: number;
  revenue: number;
}

export interface PublicStoreAnalyticsDetail extends PublicStoreAnalyticsSummary {
  weeklyOpens: number;
  weeklyOrders: number;
  conversionRate: number;
  totalRevenue: number;
  pendingRevenue: number;
  completedOrders: number;
  repeatRevenue: number;
  sourcePerformance: PublicStoreSourcePerformance[];
  topProducts: PublicStoreTopProduct[];
}

export type PublicStoreTrackedOrderStatus =
  | "placed"
  | "accepted"
  | "preparing"
  | "dispatched"
  | "in_transit"
  | "delivered";

export interface PublicStoreTrackedOrderContact {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  addressLine1: string;
  city: string;
  postcode: string;
  country: string;
}

export interface PublicStoreTrackedOrder {
  id: string;
  orderNumber: string;
  vendorId: string;
  vendorName: string;
  vendorCity: string;
  vendorSlug: string;
  currency: string;
  subtotal: number;
  delivery: number;
  platformFee: number;
  total: number;
  createdAt: string;
  estimatedDeliveryLabel: string;
  items: PublicStoreEventItemInput[];
  contact: PublicStoreTrackedOrderContact;
  status: PublicStoreTrackedOrderStatus;
  source: "backend";
  backendOrderId: string;
  backendOrderIds: string[];
}
