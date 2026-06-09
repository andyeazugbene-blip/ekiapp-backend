export interface CreateProductInput {
  title: string;
  description?: string;
  priceAmount: number;
  costAmount?: number;
  costCurrency?: string;
  currency?: string;
  images?: string[];
  category?: string;
  stock?: number;
  weightGrams?: number;
}

export interface UpdateProductInput {
  title?: string;
  description?: string | null;
  priceAmount?: number;
  costAmount?: number | null;
  costCurrency?: string | null;
  currency?: string;
  images?: string[];
  category?: string | null;
  stock?: number;
  weightGrams?: number | null;
}

export interface ListProductsQuery {
  category?: string;
  vendorId?: string;
  limit: number;
  cursor?: string;
}
