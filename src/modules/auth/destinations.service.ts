import type { CampaignStatus, OrderStatus } from "@prisma/client";

import { prisma } from "../../lib/prisma";

/** Orders waiting on the vendor to confirm, pack or dispatch. */
const ORDER_ATTENTION_STATUSES: OrderStatus[] = ["PAID", "PAYMENT_SECURED", "CONFIRMED", "VENDOR_CONFIRMED", "PROCESSING"];

/** Campaigns still in progress for the people taking part in them. */
const COMMUNITY_ACTIVE_STATUSES: CampaignStatus[] = [
  "DRAFT", "UNDER_REVIEW", "CHANGES_REQUIRED", "APPROVED", "LIVE", "PAUSED", "CLOSING", "RESCUE_WINDOW", "SUCCEEDED", "FULFILLING",
];

/** A supplier can still answer an assignment while the campaign is in one of these. */
const SUPPLIER_INVITABLE_STATUSES: CampaignStatus[] = ["DRAFT", "CHANGES_REQUIRED", "UNDER_REVIEW", "APPROVED", "LIVE", "PAUSED", "RESCUE_WINDOW"];

export type StoreState = "none" | "setup" | "live" | "restricted";

export interface AccountDestinations {
  sell: { storeState: StoreState; ordersNeedingAttention: number };
  communityBuy: { activeCount: number };
  supply: { supplierState: string; invitationCount: number };
}

/**
 * Post-login launcher status (spec M). Everything here is derived from real
 * records on each request: picking a destination never stores a role, and one
 * account can hold a store, Community Buys and supplier approval at once.
 */
export const destinationsService = {
  async getForUser(userId: string): Promise<AccountDestinations> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        vendor: { select: { id: true, verificationStatus: true, isSuspended: true } },
        supplierAccount: { select: { id: true, supplierState: true } },
      },
    });

    const vendor = user?.vendor ?? null;
    const account = user?.supplierAccount ?? null;
    const now = new Date();

    const [publishedProducts, ordersNeedingAttention, activeCount, assignedInvitations, emailInvitations] = await Promise.all([
      vendor ? prisma.product.count({ where: { vendorId: vendor.id, status: "PUBLISHED" } }) : Promise.resolve(0),
      vendor ? prisma.order.count({ where: { vendorId: vendor.id, status: { in: ORDER_ATTENTION_STATUSES } } }) : Promise.resolve(0),
      prisma.communityCampaign.count({
        where: {
          status: { in: COMMUNITY_ACTIVE_STATUSES },
          OR: [
            { organiser: { userId } },
            { contributions: { some: { participantId: userId, status: { in: ["PLEDGED", "PAYMENT_PROCESSING", "PAID", "CHARGE_FAILED"] } } } },
          ],
        },
      }),
      account
        ? prisma.communityCampaign.count({
            where: { supplierAccountId: account.id, supplierCommitted: false, supplierDeclinedAt: null, status: { in: SUPPLIER_INVITABLE_STATUSES } },
          })
        : Promise.resolve(0),
      user?.email
        ? prisma.supplierInvitation.count({ where: { email: user.email.toLowerCase(), status: "PENDING", expiresAt: { gt: now } } })
        : Promise.resolve(0),
    ]);

    let storeState: StoreState = "none";
    if (vendor) {
      if (vendor.isSuspended) storeState = "restricted";
      else storeState = vendor.verificationStatus === "VERIFIED" && publishedProducts > 0 ? "live" : "setup";
    }

    return {
      sell: { storeState, ordersNeedingAttention },
      communityBuy: { activeCount },
      supply: { supplierState: account?.supplierState ?? "NOT_STARTED", invitationCount: assignedInvitations + emailInvitations },
    };
  },
};
