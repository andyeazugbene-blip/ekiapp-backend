export interface CreateAddressInput {
  recipientName: string;
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  country: string;
  phone?: string;
  isDefault?: boolean;
}

export interface UpdateAddressInput {
  recipientName?: string;
  line1?: string;
  line2?: string | null;
  city?: string;
  postalCode?: string;
  country?: string;
  phone?: string | null;
  isDefault?: boolean;
}
