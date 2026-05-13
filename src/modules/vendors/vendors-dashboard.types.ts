export interface DashboardAlert {
  id: string;
  type: "order_action" | "low_stock" | "message" | "payout";
  label: string;
  count: number;
}

export interface VendorDashboardData {
  greeting: string;
  storeName: string;
  alerts: DashboardAlert[];
  earnings: {
    salesToday: number;
    salesThisWeek: number;
    salesThisMonth: number;
    pendingPayout: number;
    currency: string;
  };
  insights: {
    bestSellingProduct: string | null;
    totalOrders: number;
    totalProducts: number;
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
