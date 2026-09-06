import type { PayoutMethodType } from "@prisma/client";

export interface CreateVendorInput {
  storeName: string;
  description?: string;
  contactEmail?: string;
  contactPhone?: string;
  country?: string;
  /**
   * Markets this vendor serves, full country names or ISO codes (e.g.
   * "United Kingdom" or "GB"). When provided, markets[0] becomes the
   * vendor's primary Vendor.country/Vendor.currency (unchanged downstream
   * behavior for every existing single-country caller) and every entry gets
   * its own VendorMarketAssignment. Optional for backward compatibility with
   * any caller still sending only `country` — that path still creates one
   * initial assignment for it.
   */
  markets?: string[];
}

export interface UpdateVendorInput {
  storeName?: string;
  description?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  country?: string | null;
  city?: string | null;
  businessType?: "individual" | "registered" | null;
  sellerRegion?: "africa" | "abroad" | null;
  avatar?: string | null;
  coverImage?: string | null;
}

export interface CreatePayoutMethodInput {
  type: PayoutMethodType;
  label?: string;
  details: Record<string, unknown>;
  isDefault?: boolean;
}

export interface UpdatePayoutMethodInput {
  label?: string;
  details?: Record<string, unknown>;
  isDefault?: boolean;
}
