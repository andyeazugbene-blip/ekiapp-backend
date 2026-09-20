import type Stripe from "stripe";

import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";

// Stripe rejects a livemode accountLinks.create() whose refresh_url/return_url
// aren't HTTPS ("Livemode requests must always be redirected via HTTPS") —
// a bare process.env.FRONTEND_URL fallback to localhost silently broke this
// in production. env.frontendUrl already has the correct HTTPS-safe fallback.
const FRONTEND_URL = env.frontendUrl;

/**
 * Stripe Connect production hardening — the single place both sync paths
 * (the admin-triggered live refresh below, and the account.updated webhook
 * in stripe.service.ts) derive DB fields from a Stripe Account object, so
 * they can never drift into reporting different things for the same
 * account. requirements arrays are Stripe's own field-name identifiers
 * ("individual.dob.day", "external_account") — never an actual value —
 * safe to persist and to show an admin.
 */
export interface ConnectAccountFields {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  stripeRequirementsCurrentlyDue: string[];
  stripeRequirementsEventuallyDue: string[];
  stripeRequirementsPastDue: string[];
  stripeDisabledReason: string | null;
}

export function deriveConnectAccountFields(account: Stripe.Account): ConnectAccountFields {
  return {
    chargesEnabled: account.charges_enabled ?? false,
    payoutsEnabled: account.payouts_enabled ?? false,
    detailsSubmitted: account.details_submitted ?? false,
    stripeRequirementsCurrentlyDue: account.requirements?.currently_due ?? [],
    stripeRequirementsEventuallyDue: account.requirements?.eventually_due ?? [],
    stripeRequirementsPastDue: account.requirements?.past_due ?? [],
    stripeDisabledReason: account.requirements?.disabled_reason ?? null,
  };
}

/**
 * Diaspora escrow reconciliation (final V1 settlement doc §N item 5) —
 * Stripe Connect onboarding for organisers, needed now that the organiser is
 * a real payout recipient (organiser-payout.service.ts). Deliberately
 * mirrors supplier-stripe-connect.service.ts's exact pattern (Express
 * account create, onboarding link, polling-based getStatus() re-sync)
 * rather than inventing a new one — the only difference is the owning model
 * (OrganiserProfile, userId-keyed) and using the organiser's own name in
 * business_profile since there is no store/supplier name here.
 */
export const organiserStripeConnectService = {
  async onboard(userId: string): Promise<{ onboardingUrl: string }> {
    const profile = await prisma.organiserProfile.findUnique({
      where: { userId },
      include: { user: { select: { name: true, email: true } } },
    });
    if (!profile) {
      throw new AppError("Organiser profile required", 403);
    }

    let stripeAccountId = profile.providerConnectedAccountId;

    if (!stripeAccountId) {
      const created = await stripe.accounts.create({
        type: "express",
        email: profile.user.email,
        metadata: { organiserProfileId: profile.id, userId },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        business_profile: { name: profile.user.name ?? undefined },
      });
      stripeAccountId = created.id;
      await prisma.organiserProfile.update({
        where: { id: profile.id },
        data: { providerConnectedAccountId: stripeAccountId },
      });
    }

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${FRONTEND_URL}/organiser/stripe-connect?refresh=true`,
      return_url: `${FRONTEND_URL}/organiser/stripe-connect?success=true`,
      type: "account_onboarding",
    });

    return { onboardingUrl: accountLink.url };
  },

  async refresh(userId: string): Promise<{ onboardingUrl: string }> {
    const profile = await prisma.organiserProfile.findUnique({ where: { userId }, select: { id: true, providerConnectedAccountId: true } });
    if (!profile) throw new AppError("Organiser profile required", 403);
    if (!profile.providerConnectedAccountId) throw new AppError("Stripe account not created yet. Call onboard first.", 400);
    const accountLink = await stripe.accountLinks.create({
      account: profile.providerConnectedAccountId,
      refresh_url: `${FRONTEND_URL}/organiser/stripe-connect?refresh=true`,
      return_url: `${FRONTEND_URL}/organiser/stripe-connect?success=true`,
      type: "account_onboarding",
    });
    return { onboardingUrl: accountLink.url };
  },

  async getStatus(userId: string): Promise<{
    providerConnectedAccountId: string | null;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
  }> {
    const profile = await prisma.organiserProfile.findUnique({
      where: { userId },
      select: { id: true, providerConnectedAccountId: true, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
    });
    if (!profile) throw new AppError("Organiser profile required", 403);

    if (profile.providerConnectedAccountId) {
      try {
        const stripeAccount = await stripe.accounts.retrieve(profile.providerConnectedAccountId);
        const data = {
          chargesEnabled: stripeAccount.charges_enabled ?? false,
          payoutsEnabled: stripeAccount.payouts_enabled ?? false,
          detailsSubmitted: stripeAccount.details_submitted ?? false,
        };
        await prisma.organiserProfile.update({ where: { id: profile.id }, data });
        return { providerConnectedAccountId: profile.providerConnectedAccountId, ...data };
      } catch (error) {
        logger.error("Stripe account retrieve failed (organiser)", {
          organiserProfileId: profile.id,
          providerConnectedAccountId: profile.providerConnectedAccountId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      providerConnectedAccountId: profile.providerConnectedAccountId,
      chargesEnabled: profile.chargesEnabled,
      payoutsEnabled: profile.payoutsEnabled,
      detailsSubmitted: profile.detailsSubmitted,
    };
  },

  /**
   * Admin-only live refresh (Stripe Connect production hardening). Unlike
   * getStatus() above, this never silently falls back to a cached value on
   * a Stripe error — an admin asking for a live read needs to know the
   * read failed, not see stale numbers presented as current. fetchedLive
   * is the caller's only correct signal for "is this actually fresh" —
   * payout readiness must never be claimed from anything else.
   */
  async getStatusForAdmin(organiserProfileId: string): Promise<
    ConnectAccountFields & {
      providerConnectedAccountId: string | null;
      fetchedLive: boolean;
      stripeStatusFetchedAt: Date | null;
    }
  > {
    const profile = await prisma.organiserProfile.findUnique({
      where: { id: organiserProfileId },
      select: {
        id: true, providerConnectedAccountId: true, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true,
        stripeRequirementsCurrentlyDue: true, stripeRequirementsEventuallyDue: true, stripeRequirementsPastDue: true,
        stripeDisabledReason: true, stripeStatusFetchedAt: true,
      },
    });
    if (!profile) throw new AppError("Organiser profile not found", 404);

    if (!profile.providerConnectedAccountId) {
      return {
        providerConnectedAccountId: null, fetchedLive: false, stripeStatusFetchedAt: null,
        chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false,
        stripeRequirementsCurrentlyDue: [], stripeRequirementsEventuallyDue: [], stripeRequirementsPastDue: [], stripeDisabledReason: null,
      };
    }

    try {
      const account = await stripe.accounts.retrieve(profile.providerConnectedAccountId);
      const fields = deriveConnectAccountFields(account);
      const fetchedAt = new Date();
      await prisma.organiserProfile.update({ where: { id: profile.id }, data: { ...fields, stripeStatusFetchedAt: fetchedAt } });
      return { providerConnectedAccountId: profile.providerConnectedAccountId, fetchedLive: true, stripeStatusFetchedAt: fetchedAt, ...fields };
    } catch (error) {
      logger.error("Admin live Stripe Connect status refresh failed (organiser)", {
        organiserProfileId: profile.id,
        providerConnectedAccountId: profile.providerConnectedAccountId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      // Surface the cached row explicitly marked non-live — never disguise
      // a failed live read as a successful one.
      return {
        providerConnectedAccountId: profile.providerConnectedAccountId, fetchedLive: false, stripeStatusFetchedAt: profile.stripeStatusFetchedAt,
        chargesEnabled: profile.chargesEnabled, payoutsEnabled: profile.payoutsEnabled, detailsSubmitted: profile.detailsSubmitted,
        stripeRequirementsCurrentlyDue: profile.stripeRequirementsCurrentlyDue, stripeRequirementsEventuallyDue: profile.stripeRequirementsEventuallyDue,
        stripeRequirementsPastDue: profile.stripeRequirementsPastDue, stripeDisabledReason: profile.stripeDisabledReason,
      };
    }
  },

  /**
   * account.updated webhook (Stripe Connect production hardening). The
   * webhook payload already carries the full, current Account object — no
   * extra stripe.accounts.retrieve() call needed, unlike the polling paths
   * above. Returns handled:false for any connected account that isn't an
   * organiser's (the platform's single webhook endpoint receives
   * account.updated for vendor and supplier connected accounts too) —
   * never throws for that, matching every other cross-cutting webhook
   * handler in this codebase.
   */
  async handleAccountUpdated(account: Stripe.Account): Promise<{ handled: boolean }> {
    const profile = await prisma.organiserProfile.findFirst({
      where: { providerConnectedAccountId: account.id },
      select: { id: true },
    });
    if (!profile) return { handled: false };

    const fields = deriveConnectAccountFields(account);
    await prisma.organiserProfile.update({
      where: { id: profile.id },
      data: { ...fields, stripeStatusFetchedAt: new Date() },
    });
    logger.info("Organiser Stripe Connect account synced from webhook", {
      organiserProfileId: profile.id,
      accountId: account.id,
      chargesEnabled: fields.chargesEnabled,
      payoutsEnabled: fields.payoutsEnabled,
      disabledReason: fields.stripeDisabledReason,
    });
    return { handled: true };
  },
};
