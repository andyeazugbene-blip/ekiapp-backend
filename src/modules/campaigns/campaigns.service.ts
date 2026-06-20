import { OrderStatus } from "@prisma/client";
import type { Campaign } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import {
  optionalDate,
  optionalInt,
  optionalString,
  optionalStringArray,
} from "./campaigns.validation";
import type { CampaignInput, CampaignView } from "./campaigns.types";

// Statuses that count as a "real" completed purchase (payment captured).
const PAID_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.CONFIRMED,
  OrderStatus.PROCESSING,
  OrderStatus.DISPATCHED,
  OrderStatus.IN_TRANSIT,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
  OrderStatus.PAYMENT_SECURED,
  OrderStatus.VENDOR_CONFIRMED,
  OrderStatus.AUTO_RELEASED,
];

function toView(campaign: Campaign): CampaignView {
  return {
    id: campaign.id,
    name: campaign.name,
    type: campaign.type,
    active: campaign.active,
    priority: campaign.priority,
    colorTheme: campaign.colorTheme,
    title: campaign.title,
    subtitle: campaign.subtitle,
    image: campaign.image,
    startDate: campaign.startDate ? campaign.startDate.toISOString() : null,
    endDate: campaign.endDate ? campaign.endDate.toISOString() : null,
    minimumCartAmountCents: campaign.minimumCartAmountCents,
    requiredProductIds: campaign.requiredProductIds,
    requiredCategoryIds: campaign.requiredCategoryIds,
    minimumOrders: campaign.minimumOrders,
    minimumSpendCents: campaign.minimumSpendCents,
    newCustomerOnly: campaign.newCustomerOnly,
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
  };
}

export const campaignsService = {
  // ─── Admin: list all (any status) ───────────────────────────────────────
  async adminList(): Promise<CampaignView[]> {
    const campaigns = await prisma.campaign.findMany({
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    });
    return campaigns.map(toView);
  },

  // ─── Admin: create ───────────────────────────────────────────────────────
  async create(input: CampaignInput): Promise<CampaignView> {
    const campaign = await prisma.campaign.create({
      data: {
        name: input.name,
        type: input.type,
        active: input.active ?? true,
        priority: input.priority ?? 0,
        colorTheme: input.colorTheme ?? null,
        title: input.title,
        subtitle: input.subtitle ?? null,
        image: input.image ?? null,
        startDate: input.startDate ? new Date(input.startDate) : null,
        endDate: input.endDate ? new Date(input.endDate) : null,
        minimumCartAmountCents: input.minimumCartAmountCents ?? null,
        requiredProductIds: input.requiredProductIds ?? [],
        requiredCategoryIds: input.requiredCategoryIds ?? [],
        minimumOrders: input.minimumOrders ?? null,
        minimumSpendCents: input.minimumSpendCents ?? null,
        newCustomerOnly: input.newCustomerOnly ?? false,
      },
    });
    return toView(campaign);
  },

  // ─── Admin: update (partial) ──────────────────────────────────────────────
  async update(campaignId: string, raw: Record<string, unknown>): Promise<CampaignView> {
    const existing = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!existing) throw new AppError("Campaign not found", 404);

    const data: Record<string, unknown> = {};
    if (raw.name !== undefined) data.name = optionalString(raw.name) ?? existing.name;
    if (raw.type !== undefined) {
      const type = String(raw.type).toUpperCase();
      if (type !== "HOT_DEAL" && type !== "GIFT_CARD") throw new AppError("Invalid type", 400);
      data.type = type;
    }
    if (raw.active !== undefined) data.active = Boolean(raw.active);
    if (raw.priority !== undefined) data.priority = optionalInt(raw.priority, "priority") ?? 0;
    if (raw.colorTheme !== undefined) data.colorTheme = optionalString(raw.colorTheme);
    if (raw.title !== undefined) {
      const title = optionalString(raw.title);
      if (!title) throw new AppError("title is required", 400);
      data.title = title;
    }
    if (raw.subtitle !== undefined) data.subtitle = optionalString(raw.subtitle);
    if (raw.image !== undefined) data.image = optionalString(raw.image);
    if (raw.startDate !== undefined) {
      const d = optionalDate(raw.startDate, "startDate");
      data.startDate = d ? new Date(d) : null;
    }
    if (raw.endDate !== undefined) {
      const d = optionalDate(raw.endDate, "endDate");
      data.endDate = d ? new Date(d) : null;
    }
    if (raw.minimumCartAmountCents !== undefined) data.minimumCartAmountCents = optionalInt(raw.minimumCartAmountCents, "minimumCartAmountCents");
    if (raw.requiredProductIds !== undefined) data.requiredProductIds = optionalStringArray(raw.requiredProductIds, "requiredProductIds");
    if (raw.requiredCategoryIds !== undefined) data.requiredCategoryIds = optionalStringArray(raw.requiredCategoryIds, "requiredCategoryIds");
    if (raw.minimumOrders !== undefined) data.minimumOrders = optionalInt(raw.minimumOrders, "minimumOrders");
    if (raw.minimumSpendCents !== undefined) data.minimumSpendCents = optionalInt(raw.minimumSpendCents, "minimumSpendCents");
    if (raw.newCustomerOnly !== undefined) data.newCustomerOnly = Boolean(raw.newCustomerOnly);

    const updated = await prisma.campaign.update({ where: { id: campaignId }, data });
    return toView(updated);
  },

  // ─── Admin: delete ────────────────────────────────────────────────────────
  async delete(campaignId: string): Promise<void> {
    const existing = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!existing) throw new AppError("Campaign not found", 404);
    await prisma.campaign.delete({ where: { id: campaignId } });
  },

  // ─── Buyer: campaigns this user currently qualifies for ──────────────────
  async listEligibleForUser(buyerId: string | null): Promise<CampaignView[]> {
    const now = new Date();

    const campaigns = await prisma.campaign.findMany({
      where: {
        active: true,
        OR: [{ startDate: null }, { startDate: { lte: now } }],
      },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    });

    const live = campaigns.filter((c) => !c.endDate || c.endDate >= now);
    if (live.length === 0) return [];

    // Anonymous buyers only qualify for campaigns with no eligibility rules at all.
    if (!buyerId) {
      return live.filter((c) => isRuleFree(c)).map(toView);
    }

    const [cart, orderStats] = await Promise.all([
      prisma.cart.findUnique({
        where: { buyerId },
        include: { items: { include: { product: true } } },
      }),
      prisma.order.findMany({
        where: { buyerId, status: { in: PAID_STATUSES } },
        select: { subtotalAmount: true },
      }),
    ]);

    const cartTotalCents = (cart?.items ?? []).reduce(
      (sum, item) => sum + item.product.priceInCents * item.quantity,
      0,
    );
    const cartProductIds = new Set((cart?.items ?? []).map((item) => item.productId));
    const cartCategoryIds = new Set((cart?.items ?? []).map((item) => item.product.category).filter(Boolean));

    const paidOrderCount = orderStats.length;
    const totalSpendCents = orderStats.reduce((sum, o) => sum + o.subtotalAmount, 0);
    const isNewCustomer = paidOrderCount === 0;

    const eligible = live.filter((campaign) => {
      if (campaign.minimumCartAmountCents != null && cartTotalCents < campaign.minimumCartAmountCents) return false;
      if (campaign.requiredProductIds.length > 0 && !campaign.requiredProductIds.some((id) => cartProductIds.has(id))) return false;
      if (campaign.requiredCategoryIds.length > 0 && !campaign.requiredCategoryIds.some((id) => cartCategoryIds.has(id))) return false;
      if (campaign.minimumOrders != null && paidOrderCount < campaign.minimumOrders) return false;
      if (campaign.minimumSpendCents != null && totalSpendCents < campaign.minimumSpendCents) return false;
      if (campaign.newCustomerOnly && !isNewCustomer) return false;
      return true;
    });

    return eligible.map(toView);
  },
};

function isRuleFree(c: Campaign): boolean {
  return (
    c.minimumCartAmountCents == null &&
    c.requiredProductIds.length === 0 &&
    c.requiredCategoryIds.length === 0 &&
    c.minimumOrders == null &&
    c.minimumSpendCents == null &&
    !c.newCustomerOnly
  );
}
