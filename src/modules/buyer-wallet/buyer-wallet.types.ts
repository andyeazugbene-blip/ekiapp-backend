export interface TopUpInput {
  amount: number;
}

export interface TopUpResponse {
  clientSecret: string;
  paymentIntentId: string;
  amount: number;
  currency: string;
}

export interface ApplyWalletInput {
  amount: number;
  orderId: string;
}

export interface ListWalletTransactionsQuery {
  limit: number;
  cursor?: string;
}
