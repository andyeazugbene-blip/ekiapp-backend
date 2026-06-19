export interface AdminDashboardData {
  totalVendors: number;
  pendingApprovals: number;
  activeVendors: number;
  suspendedVendors: number;
  totalOrders: number;
  pendingOrders: number;
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
  vendors: { active: number };
  buyers: { active: number };
}

export interface ListAuditLogsQuery {
  actorId?: string;
  action?: string;
  entityType?: string;
  limit: number;
  cursor?: string;
}

export interface AdminAuditLogItem {
  id: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
  createdAt: Date;
  actor: {
    id: string;
    name: string;
    email: string;
    role: string;
  } | null;
}
