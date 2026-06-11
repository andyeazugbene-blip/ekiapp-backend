import type { OrderStatus } from "@prisma/client";

export interface ListBuyerOrdersQuery {
  status?: OrderStatus;
  limit: number;
  cursor?: string;
}

export interface ListVendorOrdersQuery {
  status?: OrderStatus;
  limit: number;
  cursor?: string;
}

export interface UpdateOrderStatusInput {
  status: OrderStatus;
}

// Allowed vendor transitions: PAID → CONFIRMED → PROCESSING → DISPATCHED
// + Escrow: PAYMENT_SECURED → VENDOR_CONFIRMED → DISPATCHED
export const VENDOR_STATUS_TRANSITIONS: Record<string, OrderStatus[]> = {
  PENDING: ["CONFIRMED", "PROCESSING"],
  PAID: ["CONFIRMED", "PROCESSING"],
  CONFIRMED: ["PROCESSING"],
  PROCESSING: ["DISPATCHED"],
  DISPATCHED: ["IN_TRANSIT"],
  IN_TRANSIT: ["DELIVERED"],
  DELIVERED: [],
  COMPLETED: [],
  CANCELLED: [],
  REFUNDED: [],
  FAILED: [],
  PAYMENT_SECURED: ["VENDOR_CONFIRMED"],
  VENDOR_CONFIRMED: ["DISPATCHED"],
  DISPUTED: [],
  AUTO_RELEASED: [],
};

// Allowed buyer transitions: DELIVERED → COMPLETED (mark as received)
export const BUYER_STATUS_TRANSITIONS: Record<string, OrderStatus[]> = {
  PENDING: [],
  PAID: [],
  CONFIRMED: [],
  PROCESSING: [],
  DISPATCHED: [],
  IN_TRANSIT: [],
  DELIVERED: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  REFUNDED: [],
  FAILED: [],
  PAYMENT_SECURED: [],
  VENDOR_CONFIRMED: [],
  DISPUTED: [],
  AUTO_RELEASED: [],
};
