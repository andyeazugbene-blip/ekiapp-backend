/**
 * Handbook §2.1 L132 — global admin search. Fans out across entity types and
 * returns the top few per type with a human title, secondary subtitle and a
 * deep link. Each entity group is only searched when the admin holds that
 * entity's read permission ("results filtered by what the admin may read").
 * A failing group is reported in `errors` rather than failing the request.
 */
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { adminRolesService, permissionMatches } from "./admin-roles.service";

export const SEARCH_PER_TYPE = 5;
export const SEARCH_MIN_LENGTH = 2;

export type SearchGroupKey = "users" | "vendors" | "orders" | "payments" | "campaigns" | "subscriptions";

export interface SearchResult {
  id: string;
  type: SearchGroupKey;
  title: string;
  subtitle: string;
  href: string;
  isTest?: boolean;
}

export interface SearchGroup {
  key: SearchGroupKey;
  label: string;
  results: SearchResult[];
}

export interface AdminSearchResponse {
  query: string;
  groups: SearchGroup[];
  errors: SearchGroupKey[];
  /** Groups the admin has no read access to (so the UI can say so honestly). */
  restricted: SearchGroupKey[];
}

const GROUP_PERMISSIONS: Record<SearchGroupKey, string[]> = {
  users: ["users.read"],
  vendors: ["vendors.read"],
  orders: ["orders.read"],
  payments: ["orders.read"],
  campaigns: ["community_buy.read"],
  subscriptions: ["orders.read"],
};

const GROUP_LABELS: Record<SearchGroupKey, string> = {
  users: "Users",
  vendors: "Vendors",
  orders: "Orders",
  payments: "Payments",
  campaigns: "Community Buy campaigns",
  subscriptions: "Foodstuffs Subscriptions",
};

function can(perms: string[], anyOf: string[]): boolean {
  return anyOf.some((p) => permissionMatches(perms, p));
}

const contains = (q: string) => ({ contains: q, mode: "insensitive" as const });

type Searcher = (q: string) => Promise<SearchResult[]>;

const searchers: Record<SearchGroupKey, Searcher> = {
  async users(q) {
    const rows = await prisma.user.findMany({
      where: { OR: [{ name: contains(q) }, { email: contains(q) }, { id: q }] },
      orderBy: { createdAt: "desc" }, take: SEARCH_PER_TYPE,
      select: { id: true, name: true, email: true, role: true, isTest: true },
    });
    return rows.map((u) => ({
      id: u.id, type: "users", title: u.name || u.email, subtitle: `${u.email} · ${u.role}`,
      href: `/users/${u.id}`, isTest: u.isTest,
    }));
  },
  async vendors(q) {
    const rows = await prisma.vendor.findMany({
      where: { OR: [{ storeName: contains(q) }, { user: { name: contains(q) } }, { user: { email: contains(q) } }, { id: q }] },
      orderBy: { createdAt: "desc" }, take: SEARCH_PER_TYPE,
      select: { id: true, storeName: true, isTest: true, verificationStatus: true, user: { select: { name: true, email: true } } },
    });
    return rows.map((v) => ({
      id: v.id, type: "vendors", title: v.storeName,
      subtitle: `${v.user?.name ?? "Owner not provided"} · ${v.verificationStatus}`,
      href: `/vendors/${v.id}`, isTest: v.isTest,
    }));
  },
  async orders(q) {
    const rows = await prisma.order.findMany({
      where: { OR: [{ orderNumber: contains(q) }, { id: q }] },
      orderBy: { createdAt: "desc" }, take: SEARCH_PER_TYPE,
      select: { id: true, orderNumber: true, status: true, totalAmount: true, currency: true, isTest: true, buyer: { select: { name: true } } },
    });
    return rows.map((o) => ({
      id: o.id, type: "orders", title: `Order ${o.orderNumber}`,
      subtitle: `${o.buyer?.name ?? "Buyer not provided"} · ${o.status} · ${(o.totalAmount / 100).toFixed(2)} ${o.currency}`,
      href: `/orders/${o.id}`, isTest: o.isTest,
    }));
  },
  async payments(q) {
    const rows = await prisma.payment.findMany({
      where: { OR: [{ stripePaymentIntentId: contains(q) }, { orderId: q }, { id: q }] },
      orderBy: { createdAt: "desc" }, take: SEARCH_PER_TYPE,
      select: { id: true, stripePaymentIntentId: true, status: true, amount: true, currency: true, isTest: true, order: { select: { orderNumber: true } } },
    });
    return rows.map((p) => ({
      id: p.id, type: "payments", title: p.stripePaymentIntentId ?? `Payment ${p.id}`,
      subtitle: `${p.order?.orderNumber ? `Order ${p.order.orderNumber} · ` : ""}${p.status} · ${(p.amount / 100).toFixed(2)} ${p.currency}`,
      href: `/payments/${p.id}`, isTest: p.isTest,
    }));
  },
  async campaigns(q) {
    const rows = await prisma.communityCampaign.findMany({
      where: { OR: [{ title: contains(q) }, { id: q }] },
      orderBy: { createdAt: "desc" }, take: SEARCH_PER_TYPE,
      select: { id: true, title: true, status: true, country: true },
    });
    return rows.map((c) => ({
      id: c.id, type: "campaigns", title: c.title,
      subtitle: `${c.status}${c.country ? ` · ${c.country}` : ""}`, href: `/community-campaigns/${c.id}`,
    }));
  },
  async subscriptions(q) {
    const rows = await prisma.buyerSubscription.findMany({
      where: { OR: [{ id: q }, { buyer: { name: contains(q) } }, { buyer: { email: contains(q) } }] },
      orderBy: { createdAt: "desc" }, take: SEARCH_PER_TYPE,
      select: { id: true, status: true, frequency: true, buyer: { select: { name: true, email: true, isTest: true } } },
    });
    return rows.map((s) => ({
      id: s.id, type: "subscriptions", title: `${s.buyer?.name ?? "Buyer not provided"} — subscription`,
      subtitle: `${s.status} · ${s.frequency} · ${s.buyer?.email ?? ""}`, href: `/subscriptions/${s.id}`, isTest: s.buyer?.isTest,
    }));
  },
};

export const adminSearchService = {
  async search(viewerId: string, rawQuery: string): Promise<AdminSearchResponse> {
    const query = rawQuery.trim().slice(0, 100);
    const perms = await adminRolesService.userPermissions(viewerId);
    const keys = Object.keys(searchers) as SearchGroupKey[];
    const allowed = keys.filter((k) => can(perms, GROUP_PERMISSIONS[k]));
    const restricted = keys.filter((k) => !allowed.includes(k));

    if (query.length < SEARCH_MIN_LENGTH) return { query, groups: [], errors: [], restricted };

    const settled = await Promise.allSettled(allowed.map((k) => searchers[k](query)));
    const groups: SearchGroup[] = [];
    const errors: SearchGroupKey[] = [];
    settled.forEach((res, i) => {
      const key = allowed[i];
      if (res.status === "fulfilled") {
        if (res.value.length) groups.push({ key, label: GROUP_LABELS[key], results: res.value });
      } else {
        errors.push(key);
        logger.error("Admin search group failed", {
          group: key, errorMessage: res.reason instanceof Error ? res.reason.message : String(res.reason),
        });
      }
    });
    return { query, groups, errors, restricted };
  },
};
