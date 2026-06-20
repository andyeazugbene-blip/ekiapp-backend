import type { CampaignDiscountType, CampaignType } from "@prisma/client";

export interface CampaignInput {
  name: string;
  type: CampaignType;
  active?: boolean;
  priority?: number;
  colorTheme?: string | null;
  title: string;
  subtitle?: string | null;
  image?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  minimumCartAmountCents?: number | null;
  requiredProductIds?: string[];
  requiredCategoryIds?: string[];
  minimumOrders?: number | null;
  minimumSpendCents?: number | null;
  newCustomerOnly?: boolean;
  discountType?: CampaignDiscountType | null;
  discountValue?: number | null;
}

export interface CampaignView {
  id: string;
  name: string;
  type: CampaignType;
  active: boolean;
  priority: number;
  colorTheme: string | null;
  title: string;
  subtitle: string | null;
  image: string | null;
  startDate: string | null;
  endDate: string | null;
  minimumCartAmountCents: number | null;
  requiredProductIds: string[];
  requiredCategoryIds: string[];
  minimumOrders: number | null;
  minimumSpendCents: number | null;
  newCustomerOnly: boolean;
  discountType: CampaignDiscountType | null;
  discountValue: number | null;
  createdAt: string;
  updatedAt: string;
}
