import type { PromoType } from "@prisma/client";

export interface CreatePromoCodeInput {
  code: string;
  type: PromoType;
  value: number;
  minOrderAmount?: number;
  maxUses?: number;
  validFrom?: string;
  validUntil?: string;
}

export interface UpdatePromoCodeInput {
  isActive?: boolean;
  maxUses?: number;
  validUntil?: string | null;
}

export interface ValidatePromoInput {
  code: string;
  orderAmount: number;
}

export interface PromoValidationResult {
  valid: boolean;
  discountAmount: number;
  code: string;
  type: PromoType;
  value: number;
}

export interface CreateVendorPromoCodeInput extends CreatePromoCodeInput {
  productIds: string[];
  audience: "all" | "repeat" | "new" | "country";
  audienceCountry?: string;
}

export interface VendorPromoCodeView {
  id: string;
  code: string;
  type: PromoType;
  value: number;
  minOrderAmount?: number | null;
  maxUses?: number | null;
  usedCount: number;
  isActive: boolean;
  validFrom: string;
  validUntil?: string | null;
  createdAt: string;
  productIds: string[];
  audience: "all" | "repeat" | "new" | "country";
  audienceCountry?: string;
  shareUrl: string;
}
