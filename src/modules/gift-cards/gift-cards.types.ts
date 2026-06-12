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
  createdAt: string;
}

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
