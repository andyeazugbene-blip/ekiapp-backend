export interface AdminDashboardData {
  totalVendors: number;
  pendingApprovals: number;
  activeVendors: number;
  suspendedVendors: number;
  totalOrders: number;
  totalRevenue: number;
  totalBuyers: number;
  newVendorsThisWeek: number;
  newOrdersThisWeek: number;
  currency: string;
}

export interface AdminAnalyticsData {
  revenue: {
    today: number;
    thisWeek: number;
    thisMonth: number;
    allTime: number;
    currency: string;
  };
  orders: {
    total: number;
    pending: number;
    paid: number;
    completed: number;
    failed: number;
  };
  topVendors: {
    vendorId: string;
    storeName: string;
    totalOrders: number;
    totalRevenue: number;
  }[];
  growth: {
    newUsersThisWeek: number;
    newVendorsThisWeek: number;
    newOrdersThisWeek: number;
  };
}

export interface ListAuditLogsQuery {
  actorId?: string;
  action?: string;
  entityType?: string;
  limit: number;
  cursor?: string;
}
