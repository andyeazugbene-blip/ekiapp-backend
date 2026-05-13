export interface CreateDeliveryZoneInput {
  name: string;
  country: string;
  flag?: string;
  baseFeeAmount: number;
  feePerKgAmount: number;
  currency?: string;
  isActive?: boolean;
}

export interface UpdateDeliveryZoneInput {
  name?: string;
  country?: string;
  flag?: string | null;
  baseFeeAmount?: number;
  feePerKgAmount?: number;
  currency?: string;
  isActive?: boolean;
}

export interface CreateDeliveryMethodInput {
  label: string;
  priceAmount: number;
  minDays: number;
  maxDays: number;
  isActive?: boolean;
}

export interface UpdateDeliveryMethodInput {
  label?: string;
  priceAmount?: number;
  minDays?: number;
  maxDays?: number;
  isActive?: boolean;
}
