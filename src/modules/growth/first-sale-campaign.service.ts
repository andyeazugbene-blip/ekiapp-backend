import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { countryNamesForMarketCode, resolveMarketCode } from "../../shared/currency";
import { recordAudit } from "../../shared/utils/audit";
import { launchSettingsService } from "../admin/launch-settings.service";
import { notificationsService } from "../notifications/notifications.service";
import { EVENT_NAMES, eventsService } from "../events/events.service";

const LAUNCH_PRODUCT_COUNT = 3;
const PAID_STATUSES = ["PAID", "CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT", "DELIVERED", "COMPLETED", "PAYMENT_SECURED", "VENDOR_CONFIRMED"] as const;

type Check = { key: string; label: string; done: boolean; blocking: boolean; route: string };
type Product = { id: string; title: string; stock: number; images: string[]; weightGrams: number | null; category: string | null; description: string | null; priceInCents: number; currency: string };

/** Handbook 8.3 step 2: complete, in stock and clear about quantity comes first. */
export function rankLaunchProducts<T extends Pick<Product, "stock" | "images" | "weightGrams" | "description">>(products: T[]): T[] {
  const score = (p: T) => (p.images.length > 0 ? 3 : 0) + (p.weightGrams ? 2 : 0) + (p.description ? 1 : 0) + Math.min(p.stock, 20) / 20;
  return products.filter((p) => p.stock > 0).sort((a, b) => score(b) - score(a));
}

/** Handbook 8.3 step 7: answer the actual bottleneck, not a generic tip. */
export function funnelBottleneck(funnel: { visits: number; baskets: number; checkouts: number; payments: number }): { stage: string; advice: string } | null {
  if (funnel.payments > 0) return null;
  if (funnel.visits === 0) return { stage: "visits", advice: "Nobody has opened your store yet. Share your store link with the buyers you already know." };
  if (funnel.baskets === 0) return { stage: "baskets", advice: "People are visiting but not adding to their basket. Check your prices, photos and pack sizes." };
  if (funnel.checkouts === 0) return { stage: "checkouts", advice: "Baskets aren't reaching checkout. Check your delivery areas and delivery charges." };
  return { stage: "payments", advice: "Checkouts aren't completing. Our team has been asked to take a look." };
}

async function loadVendor(vendorUserId: string) {
  const vendor = await prisma.vendor.findUnique({
    where: { userId: vendorUserId },
    select: { id: true, userId: true, storeName: true, storeSlug: true, country: true, isTest: true, isSuspended: true, verificationStatus: true, stripeAccountId: true },
  });
  if (!vendor) throw new AppError("Vendor profile required", 403);
  return vendor;
}

async function hasPaidOrder(vendorId: string): Promise<boolean> {
  return (await prisma.orderItem.count({ where: { vendorId, order: { status: { in: [...PAID_STATUSES] } } } })) > 0;
}

function countryForms(country: string): string[] {
  const code = resolveMarketCode(country);
  return [...new Set([country, ...(code ? [code, ...countryNamesForMarketCode(code)] : [])])];
}

/** Handbook 8.3 step 4: only buyers who agreed to marketing, in this store's world and country. */
function audienceWhere(vendor: { userId: string; country: string | null; isTest: boolean }) {
  return {
    role: "BUYER" as const,
    isTest: vendor.isTest,
    isSuspended: false,
    marketingConsentAt: { not: null },
    id: { not: vendor.userId },
    // Accounts hold a country as a name or a code, so match both.
    ...(vendor.country ? { country: { in: countryForms(vendor.country) } } : {}),
  };
}

async function funnelFor(vendorId: string, since: Date | null) {
  const from = since ?? new Date(0);
  const [visits, baskets, checkouts, payments] = await Promise.all([
    prisma.event.count({ where: { name: "store_viewed", entityType: "Vendor", entityId: vendorId, occurredAt: { gte: from } } }),
    prisma.cartItem.count({ where: { product: { vendorId }, createdAt: { gte: from } } }),
    prisma.order.count({ where: { items: { some: { vendorId } }, createdAt: { gte: from } } }),
    prisma.order.count({ where: { items: { some: { vendorId } }, payment: { status: "SUCCEEDED" }, createdAt: { gte: from } } }),
  ]);
  return { visits, baskets, checkouts, payments };
}

export const firstSaleCampaignService = {
  /** Everything the screen shows, worked out fresh, so it's never out of date. */
  async view(vendorUserId: string) {
    const vendor = await loadVendor(vendorUserId);
    const [campaign, products, zones, enabled, paid] = await Promise.all([
      prisma.firstSaleCampaign.findUnique({ where: { vendorId: vendor.id } }),
      prisma.product.findMany({
        where: { vendorId: vendor.id, isActive: true, status: "PUBLISHED" },
        select: { id: true, title: true, stock: true, images: true, weightGrams: true, category: true, description: true, priceInCents: true, currency: true },
        take: 100,
      }),
      prisma.deliveryZone.count({ where: { vendorId: vendor.id, isActive: true } }),
      launchSettingsService.isOn("FIRST_SALE_ENGINE_ENABLED"),
      hasPaidOrder(vendor.id),
    ]);
    const ranked = rankLaunchProducts(products);
    const checks: Check[] = [
      { key: "product", label: "Foodstuff in your store", done: products.length > 0, blocking: true, route: "/(vendor)/foodstuff-add" },
      { key: "stock", label: "Foodstuff in stock", done: ranked.length > 0, blocking: true, route: "/(vendor)/foodstuff" },
      { key: "quantity", label: "Weight or pack size on your foodstuff", done: products.some((p) => !!p.weightGrams), blocking: true, route: "/(vendor)/foodstuff" },
      { key: "delivery", label: "Delivery set up", done: zones > 0, blocking: true, route: "/(vendor)/delivery" },
      { key: "checkout", label: "Store open for orders", done: !vendor.isSuspended, blocking: true, route: "/(vendor)/settings" },
      // Unverified vendors can sell. These only stop a withdrawal, so they don't stop a launch.
      { key: "verification", label: "Verification, needed before you withdraw", done: vendor.verificationStatus === "VERIFIED", blocking: false, route: "/(vendor-verification)" },
      { key: "payout", label: "Payout account, needed before you withdraw", done: !!vendor.stripeAccountId, blocking: false, route: "/(vendor)/earnings" },
    ];
    const selected = campaign?.launchProductIds.length ? ranked.filter((p) => campaign.launchProductIds.includes(p.id)) : ranked.slice(0, LAUNCH_PRODUCT_COUNT);
    const storeUrl = `${env.frontendUrl}/store/${vendor.storeSlug}`;
    const eligibleBuyers = await prisma.user.count({ where: audienceWhere(vendor) });
    const funnel = await funnelFor(vendor.id, campaign?.startedAt ?? null);
    return {
      enabled,
      status: campaign?.status ?? (paid ? "NOT_NEEDED" : "NOT_STARTED"),
      readiness: checks,
      readinessScore: Math.round((checks.filter((check) => check.done).length / checks.length) * 100),
      canLaunch: enabled && !paid && !campaign && checks.filter((c) => c.blocking).every((c) => c.done),
      launchProducts: selected.map((p) => ({ id: p.id, title: p.title, image: p.images[0] ?? null, priceInCents: p.priceInCents, currency: p.currency })),
      assets: {
        storeUrl,
        shareMessage: `${vendor.storeName} is now on Eki. ${selected[0] ? `Order ${selected.map((p) => p.title).join(", ")} and more. ` : ""}${storeUrl}`,
      },
      audience: { eligibleBuyers, messaged: campaign?.buyersMessaged ?? 0 },
      funnel,
      nextStep: campaign?.status === "ACTIVE" ? funnelBottleneck(funnel) : null,
      startedAt: campaign?.startedAt ?? null,
      completedAt: campaign?.completedAt ?? null,
    };
  },

  /** Handbook 8.3 steps 4 and 5. The vendor approves, and one vendor only ever gets one campaign. */
  async launch(vendorUserId: string) {
    const vendor = await loadVendor(vendorUserId);
    const view = await this.view(vendorUserId);
    if (!view.enabled) throw new AppError("First Sale Campaigns are switched off right now.", 409, undefined, "FIRST_SALE_DISABLED");
    if (await prisma.firstSaleCampaign.findUnique({ where: { vendorId: vendor.id }, select: { id: true } })) {
      throw new AppError("Your First Sale Campaign has already started.", 409, undefined, "FIRST_SALE_ALREADY_STARTED");
    }
    if (!view.canLaunch) throw new AppError("Finish the steps above first.", 409, undefined, "FIRST_SALE_NOT_READY");

    const productIds = view.launchProducts.map((p) => p.id);
    let campaign;
    try {
      campaign = await prisma.firstSaleCampaign.create({ data: { vendorId: vendor.id, status: "ACTIVE", launchProductIds: productIds, startedAt: new Date(), approvedAt: new Date() } });
    } catch (error) {
      if ((error as { code?: string })?.code === "P2002") throw new AppError("Your First Sale Campaign has already started.", 409, undefined, "FIRST_SALE_ALREADY_STARTED");
      throw error;
    }
    // The vendor creates, approves and launches in one step.
    for (const name of [EVENT_NAMES.campaign_created, EVENT_NAMES.campaign_approved, EVENT_NAMES.campaign_launched]) {
      eventsService.emit({ name, actorType: "vendor", actorId: vendorUserId, entityType: "FirstSaleCampaign", entityId: campaign.id, secondaryEntities: { vendorId: vendor.id }, source: "vendor_app" });
    }
    const cap = await launchSettingsService.get("FIRST_SALE_MAX_BUYERS");
    const categories = (await prisma.product.findMany({ where: { id: { in: productIds } }, select: { category: true } })).map((p) => p.category).filter((c): c is string => !!c);
    // People who already buy this kind of foodstuff hear first.
    const interested = categories.length
      ? await prisma.user.findMany({ where: { ...audienceWhere(vendor), orders: { some: { items: { some: { product: { category: { in: categories } } } } } } }, select: { id: true }, take: cap })
      : [];
    const others = interested.length < cap
      ? await prisma.user.findMany({ where: { ...audienceWhere(vendor), id: { notIn: [vendor.userId, ...interested.map((u) => u.id)] } }, select: { id: true }, take: cap - interested.length, orderBy: { createdAt: "desc" } })
      : [];
    const buyers = [...interested, ...others];
    let messaged = 0;
    for (const buyer of buyers) {
      try {
        await notificationsService.enqueue({
          userId: buyer.id,
          type: "ADMIN_BROADCAST",
          title: `New on Eki: ${vendor.storeName}`,
          body: "A new store has joined near you. See what they offer.",
          data: { type: "first_sale_campaign", event: "store_introduced", vendorId: vendor.id } as never,
          dedupeKey: `first_sale_intro:${vendor.id}:${buyer.id}`,
        });
        messaged += 1;
      } catch (error) {
        logger.warn("First sale introduction wasn't sent", { vendorId: vendor.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await prisma.firstSaleCampaign.update({ where: { id: campaign.id }, data: { buyersMessaged: messaged } });
    await recordAudit({ actorId: vendorUserId, action: "first_sale_campaign.launched", entityType: "FirstSaleCampaign", entityId: campaign.id, metadata: { messaged, productIds } });
    return this.view(vendorUserId);
  },

  /** Handbook 8.3 step 7: finishes on the first paid order, and raises stuck checkouts with the team. */
  async sweep() {
    const active = await prisma.firstSaleCampaign.findMany({ where: { status: "ACTIVE" }, select: { id: true, vendorId: true, startedAt: true, escalatedAt: true } });
    let completed = 0;
    let escalated = 0;
    for (const campaign of active) {
      if (await hasPaidOrder(campaign.vendorId)) {
        await prisma.firstSaleCampaign.update({ where: { id: campaign.id }, data: { status: "COMPLETED", completedAt: new Date() } });
        completed += 1;
        continue;
      }
      const funnel = await funnelFor(campaign.vendorId, campaign.startedAt);
      if (!campaign.escalatedAt && funnelBottleneck(funnel)?.stage === "payments") {
        await prisma.firstSaleCampaign.update({ where: { id: campaign.id }, data: { escalatedAt: new Date() } });
        escalated += 1;
      }
    }
    return { active: active.length, completed, escalated };
  },

  async listForAdmin() {
    const rows = await prisma.firstSaleCampaign.findMany({ orderBy: { createdAt: "desc" }, take: 100, include: { vendor: { select: { storeName: true, isTest: true } } } });
    return rows.map((c) => ({ id: c.id, store: c.vendor.storeName, isTest: c.vendor.isTest, status: c.status, buyersMessaged: c.buyersMessaged, startedAt: c.startedAt, completedAt: c.completedAt, escalatedAt: c.escalatedAt, stoppedAt: c.stoppedAt }));
  },

  /** The admin's stop button for one campaign. The setting stops all new ones. */
  async stop(adminId: string, campaignId: string, reason: string) {
    const claim = await prisma.firstSaleCampaign.updateMany({ where: { id: campaignId, status: "ACTIVE" }, data: { status: "STOPPED", stoppedAt: new Date(), stoppedById: adminId } });
    if (claim.count !== 1) throw new AppError("This campaign isn't running.", 409, undefined, "FIRST_SALE_NOT_ACTIVE");
    await recordAudit({ actorId: adminId, action: "first_sale_campaign.stopped", entityType: "FirstSaleCampaign", entityId: campaignId, reason, failClosed: true });
    return { stopped: true };
  },
};
