export interface CalculateDeliveryInput {
  cartId: string;
  destinationZoneId: string;
}

export interface CalculateDeliveryResult {
  subtotalAmount: number;
  deliveryAmount: number;
  totalAmount: number;
  totalWeightGrams: number;
  currency: string;
}
