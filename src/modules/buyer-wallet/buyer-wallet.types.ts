export interface TopUpInput {
  amount: number;
}

export interface ApplyWalletInput {
  amount: number;
  orderId: string;
}

export interface ListWalletTransactionsQuery {
  limit: number;
  cursor?: string;
}
