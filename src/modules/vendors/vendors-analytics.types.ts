export type VendorAnalyticsRange = "today" | "7d" | "month" | "30d" | "all";

export interface VendorAnalyticsSummary {
  currency: string;
  totalRevenue: number;
  estimatedProfit: number;
  estimatedProfitAvailable: boolean;
  availableForPayout: number;
  pendingBalance: number;
}

export interface VendorAnalyticsFunnel {
  storeVisits: number;
  checkoutStarted: number;
  ordersCompleted: number;
  conversionRate: number;
  repeatOrders: number;
  storeSaves: number;
}

export interface VendorAnalyticsCustomerInsights {
  newBuyers: number;
  repeatBuyers: number;
  inactiveBuyers30d: number;
}

export interface VendorAnalyticsTopProduct {
  productId: string;
  name: string;
  orders: number;
  unitsSold: number;
  revenue: number;
  estimatedProfit?: number;
  hasCost: boolean;
}

export interface VendorAnalyticsInsight {
  id: string;
  title: string;
  body: string;
  action: "send_offer" | "restock_product" | "view_buyers" | "send_reminder" | "share_store" | "share_product";
  actionLabel: string;
  productId?: string;
  severity?: "info" | "warning" | "success";
}

export interface VendorAnalyticsData {
  range: VendorAnalyticsRange;
  summary: VendorAnalyticsSummary;
  salesFunnel: VendorAnalyticsFunnel;
  customerInsights: VendorAnalyticsCustomerInsights;
  topProducts: VendorAnalyticsTopProduct[];
  insights: VendorAnalyticsInsight[];
}
