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
