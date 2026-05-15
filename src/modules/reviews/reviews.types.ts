import type { ReviewStatus } from "@prisma/client";

export interface CreateReviewInput {
  orderId: string;
  vendorId: string;
  productId?: string;
  rating: number; // 1-5
  comment?: string;
}

export interface ListReviewsQuery {
  vendorId?: string;
  productId?: string;
  limit: number;
  cursor?: string;
}

export interface AdminListReviewsQuery {
  status?: ReviewStatus;
  limit: number;
  cursor?: string;
}

export interface ModerateReviewInput {
  status: "APPROVED" | "HIDDEN" | "REJECTED";
}

export interface ReviewWithMeta {
  id: string;
  buyerId: string;
  buyerName: string;
  vendorId: string;
  productId: string | null;
  orderId: string;
  rating: number;
  comment: string | null;
  status: ReviewStatus;
  createdAt: Date;
}
