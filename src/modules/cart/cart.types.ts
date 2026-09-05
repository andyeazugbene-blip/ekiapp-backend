export interface AddCartItemInput {
  productId: string;
  quantity: number;
}

export interface UpdateCartItemInput {
  quantity: number;
}

export interface CartSummaryEntry {
  currency: string;
  itemCount: number;
  updatedAt: string;
}
