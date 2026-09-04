export interface DashboardAlert {
  id: string;
  type: "order_action" | "low_stock" | "message" | "payout";
  label: string;
  count: number;
}

export interface RecommendedAction {
  id: string;
  type: string;
  label: string;
  reason: string;
}

export interface DashboardToolEntry {
  id: string;
  type: string;
  label: string;
  route: string;
  count?: number;
}

/**
 * architecture doc §"Module 3 — Dashboard Orchestration" / spec §20 screen 01
 * ("GET /vendor/dashboard"). `urgent_actions`/`recommended_action`/etc are
 * the canonical shape the spec defines; the flat legacy fields below them
 * (greeting/storeName/alerts/earnings/insights) are kept unchanged so the
 * existing mobile client keeps working without any client-side change —
 * this is additive, not a replacement of what's already shipped.
 */
export interface VendorDashboardData {
  greeting: string;
  storeName: string;
  alerts: DashboardAlert[];
  earnings: {
    salesToday: number;
    salesThisWeek: number;
    salesThisMonth: number;
    pendingPayout: number;
    availableBalance: number;
    currency: string;
  };
  insights: {
    bestSellingProduct: string | null;
    totalOrders: number;
    totalProducts: number;
  };

  header: {
    greeting: string;
    storeName: string;
    verified: boolean;
  };
  urgent_actions: DashboardAlert[];
  recommended_action: RecommendedAction | null;
  business_overview: {
    salesToday: number;
    salesThisWeek: number;
    salesThisMonth: number;
    currency: string;
    pendingPayout: number;
    availableBalance: number;
    bestSellingProduct: string | null;
    totalOrders: number;
    totalProducts: number;
  };
  marketing_tools: DashboardToolEntry[];
  business_tools: DashboardToolEntry[];
  business_counts: {
    products: number;
    orders: number;
    buyers: number;
    lowStock: number;
  };
  performance: {
    rating: number;
    totalReviews: number;
    repeatBuyers: number;
  };
  vendor_account_status: {
    verificationStatus: string;
    accountStatus: string;
    serviceLevel: string;
    serviceName: string;
    ordersRemaining: number | null;
    maxOrders: number | null;
    renewalDate: string | null;
  };
}

export interface VendorEarningsData {
  totalEarnings: number;
  pendingPayout: number;
  availableBalance: number;
  salesToday: number;
  salesThisWeek: number;
  salesThisMonth: number;
  currency: string;
  recentPayouts: {
    id: string;
    amount: number;
    currency: string;
    status: string;
    createdAt: Date;
  }[];
}
