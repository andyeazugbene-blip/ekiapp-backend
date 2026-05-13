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
