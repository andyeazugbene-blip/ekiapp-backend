import type { PayoutMethodType } from "@prisma/client";

export interface CreateVendorInput {
  storeName: string;
  description?: string;
  contactEmail?: string;
  contactPhone?: string;
  country?: string;
}

export interface UpdateVendorInput {
  storeName?: string;
  description?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  country?: string | null;
  city?: string | null;
  avatar?: string | null;
  coverImage?: string | null;
}

export interface CreatePayoutMethodInput {
  type: PayoutMethodType;
  label?: string;
  details: Record<string, unknown>;
  isDefault?: boolean;
}
