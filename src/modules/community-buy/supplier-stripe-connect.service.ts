import type Stripe from "stripe";

import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";
import { supplierAccountService } from "./supplier-account.service";

// Stripe rejects a livemode accountLinks.create() whose refresh_url/return_url
// aren't HTTPS ("Livemode requests must always be redirected via HTTPS") —
// a bare process.env.FRONTEND_URL fallback to localhost silently broke this
// in production. env.frontendUrl already has the correct HTTPS-safe fallback.
const FRONTEND_URL = env.frontendUrl;

/**
 * Community Buy Workstream 3 — Stripe Connect onboarding for the no-Vendor
 * SupplierAccount path (mandate item 2: "Stripe Connect onboarding where
 * applicable"). Deliberately mirrors vendors/stripe-connect.service.ts's
 * exact pattern (Express account create, onboarding link, polling-based
 * getStatus() re-sync) rather than inventing a new one — the only
 * differences are the owning model (SupplierAccount, userId-keyed, no
 * Vendor required) and using the User's own name in business_profile since
 * there is no store name here.
 *
 * handleAccountUpdated() below closes a real gap found 19 Oct 2026: without
 * it, a SupplierAccount's status only ever re-synced from getStatus()'s
 * live poll, which the controller stops calling once chargesEnabled/
 * payoutsEnabled both go true (see community-buy.controller.ts
 * getMySupplierProfile) — so a LATER Stripe-side change (fraud flag, bank
 * account removed, compliance hold disabling payouts_enabled) had no path
 * back into the DB at all, leaving assessPayoutEligibility() reading
 * permanently-stale "enabled" flags. Wired into the account.updated webhook
 * the same way organiser/vendor already are — see stripe.service.ts's
 * handleOrganiserConnectAccountUpdated.
 */
export const supplierStripeConnectService = {
  async onboard(userId: string): Promise<{ onboardingUrl: string }> {
    const account = await prisma.supplierAccount.findUnique({
      where: { userId },
      include: { user: { select: { name: true, email: true } } },
    });
    if (!account) {
      throw new AppError("Supplier account required", 403);
    }

    let stripeAccountId = account.providerConnectedAccountId;

    if (!stripeAccountId) {
      const created = await stripe.accounts.create({
        type: "express",
        email: account.user.email,
        metadata: { supplierAccountId: account.id, userId },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        business_profile: { name: account.user.name ?? undefined },
      });
      stripeAccountId = created.id;
      await prisma.supplierAccount.update({
        where: { id: account.id },
        data: { providerConnectedAccountId: stripeAccountId },
      });
    }

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${FRONTEND_URL}/supplier/stripe-connect?refresh=true`,
      return_url: `${FRONTEND_URL}/supplier/stripe-connect?success=true`,
      type: "account_onboarding",
    });

    return { onboardingUrl: accountLink.url };
  },

  async refresh(userId: string): Promise<{ onboardingUrl: string }> {
    const account = await prisma.supplierAccount.findUnique({ where: { userId }, select: { id: true, providerConnectedAccountId: true } });
    if (!account) throw new AppError("Supplier account required", 403);
    if (!account.providerConnectedAccountId) throw new AppError("Stripe account not created yet. Call onboard first.", 400);
    const accountLink = await stripe.accountLinks.create({
      account: account.providerConnectedAccountId,
      refresh_url: `${FRONTEND_URL}/supplier/stripe-connect?refresh=true`,
      return_url: `${FRONTEND_URL}/supplier/stripe-connect?success=true`,
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
    const account = await prisma.supplierAccount.findUnique({
      where: { userId },
      select: { id: true, providerConnectedAccountId: true, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
    });
    if (!account) throw new AppError("Supplier account required", 403);

    if (account.providerConnectedAccountId) {
      try {
        const stripeAccount = await stripe.accounts.retrieve(account.providerConnectedAccountId);
        const data = {
          chargesEnabled: stripeAccount.charges_enabled ?? false,
          payoutsEnabled: stripeAccount.payouts_enabled ?? false,
          detailsSubmitted: stripeAccount.details_submitted ?? false,
        };
        await prisma.supplierAccount.update({ where: { id: account.id }, data });
        // M5 — Stripe's own outstanding-requirements list, kept separate
        // from the Eki-side requirementsDue; may demote UNDER_REVIEW to
        // VERIFICATION_REQUIRED (and promote back), never touches a
        // decided state — see syncStripeRequirements()'s own doc comment.
        await supplierAccountService.syncStripeRequirements(account.id, stripeAccount.requirements?.currently_due ?? []);
        return { providerConnectedAccountId: account.providerConnectedAccountId, ...data };
      } catch (error) {
        logger.error("Stripe account retrieve failed (supplier)", {
          supplierAccountId: account.id,
          providerConnectedAccountId: account.providerConnectedAccountId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      providerConnectedAccountId: account.providerConnectedAccountId,
      chargesEnabled: account.chargesEnabled,
      payoutsEnabled: account.payoutsEnabled,
      detailsSubmitted: account.detailsSubmitted,
    };
  },

  /**
   * Handle account.updated for a SUPPLIER connected account (webhook or
   * admin refresh). Mirrors vendors/stripe-connect.service.ts's
   * handleAccountUpdated exactly: returns { handled: false } when the
   * account belongs to no SupplierAccount so the webhook router can treat
   * it as a safe no-op; uses the account object delivered in the event
   * (no extra API call); throws on DB failure so the webhook layer can
   * release its idempotency claim and let Stripe retry.
   */
  async handleAccountUpdated(account: Stripe.Account): Promise<{ handled: boolean }> {
    const supplierAccount = await prisma.supplierAccount.findFirst({
      where: { providerConnectedAccountId: account.id },
      select: { id: true },
    });
    if (!supplierAccount) {
      logger.info("Stripe Connect webhook: no supplier account for account", { accountId: account.id });
      return { handled: false };
    }

    const data = {
      chargesEnabled: account.charges_enabled ?? false,
      payoutsEnabled: account.payouts_enabled ?? false,
      detailsSubmitted: account.details_submitted ?? false,
    };
    await prisma.supplierAccount.update({ where: { id: supplierAccount.id }, data });
    // Same M5 sync used by getStatus()'s live poll — see that function's
    // own comment for why this is kept separate from requirementsDue.
    await supplierAccountService.syncStripeRequirements(supplierAccount.id, account.requirements?.currently_due ?? []);

    logger.info("Supplier Stripe Connect account synced from webhook", {
      supplierAccountId: supplierAccount.id,
      accountId: account.id,
      chargesEnabled: data.chargesEnabled,
      payoutsEnabled: data.payoutsEnabled,
    });
    return { handled: true };
  },
};
