export interface CreateGiftCardInput {
  title: string;
  description?: string;
  priceAmount: number;
  currency?: string;
  imageUrl?: string;
  isActive?: boolean;
}

export interface UpdateGiftCardInput {
  title?: string;
  description?: string;
  priceAmount?: number;
  currency?: string;
  imageUrl?: string;
  isActive?: boolean;
}

export interface GiftCardView {
  id: string;
  title: string;
  description: string | null;
  priceAmount: number;
  priceFormatted: string;
  currency: string;
  imageUrl: string | null;
  isActive: boolean;
  archivedAt: string | null;
  purchasedCount?: number;
  createdAt: string;
}

export type GiftCardEffectiveStatus =
  | "PENDING_PAYMENT"
  | "ACTIVE"
  | "PAUSED"
  | "REDEEMED"
  | "EXPIRED"
  | "CANCELLED";

export interface PurchasedGiftCardView {
  id: string;
  giftCardId: string;
  title: string;
  imageUrl: string | null;
  recipientEmail: string | null;
  recipientName: string | null;
  message: string | null;
  amount: number;
  currency: string;
  remainingBalance: number;
  status: GiftCardEffectiveStatus;
  /** Formatted XXXX-XXXX-XXXX-XXXX; only ever returned to the purchaser. */
  code: string | null;
  paidAt: string | null;
  expiresAt: string | null;
  isRedeemed: boolean;
  redeemedAt: string | null;
  createdAt: string;
}

export interface PurchaseGiftCardInput {
  giftCardId: string;
  recipientEmail?: string;
  recipientName?: string;
  message?: string;
}

export interface RedeemGiftCardInput {
  code: string;
  /** Minor units. Omitted = redeem the full remaining balance. */
  amount?: number;
}

export interface RedeemGiftCardResult {
  redemptionId: string;
  amountMinor: number;
  currency: string;
  remainingBalance: number;
  status: GiftCardEffectiveStatus;
  walletBalance: number;
}
