import type { ShipmentStatus } from "@prisma/client";

export interface CreateShipmentInput {
  trackingNumber?: string;
  carrier?: string;
  estimatedDeliveryAt?: string; // ISO date string
}

export interface UpdateShipmentInput {
  trackingNumber?: string;
  carrier?: string;
  status?: ShipmentStatus;
  estimatedDeliveryAt?: string | null;
}

export interface ListShipmentsQuery {
  status?: ShipmentStatus;
  limit: number;
  cursor?: string;
}
