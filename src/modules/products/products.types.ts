export interface CreateProductInput {
  title: string;
  description?: string;
  priceAmount: number;
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
