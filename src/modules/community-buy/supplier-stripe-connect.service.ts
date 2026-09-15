import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";
import { supplierAccountService } from "./supplier-account.service";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";

/**
 * Community Buy Workstream 3 — Stripe Connect onboarding for the no-Vendor
 * SupplierAccount path (mandate item 2: "Stripe Connect onboarding where
 * applicable"). Deliberately mirrors vendors/stripe-connect.service.ts's
 * exact pattern (Express account create, onboarding link, polling-based
 * getStatus() re-sync) rather than inventing a new one — the only
 * differences are the owning model (SupplierAccount, userId-keyed, no
 * Vendor required) and using the User's own name in business_profile since
 * there is no store name here. No webhook wiring is added: the vendor path
 * this mirrors has none either (confirmed — handleAccountUpdated is never
 * called from anywhere), so getStatus()'s live Stripe re-sync is the only
 * mechanism either path has, and that's unchanged here.
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
};
