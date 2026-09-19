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
};
