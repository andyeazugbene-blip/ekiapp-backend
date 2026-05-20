import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";

export const stripeConnectService = {
  /**
   * Create a Stripe Express account for the vendor and return an onboarding link.
   */
  async onboard(userId: string): Promise<{ onboardingUrl: string }> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      include: { user: { select: { email: true } } },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    let accountId = vendor.stripeAccountId;

    // Create Stripe Express account if not exists
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: vendor.contactEmail ?? vendor.user.email,
        metadata: {
          vendorId: vendor.id,
          userId,
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: {
          name: vendor.storeName,
        },
      });

      accountId = account.id;

      await prisma.vendor.update({
        where: { id: vendor.id },
        data: {
          stripeAccountId: accountId,
          stripeAccountStatus: "onboarding",
        },
      });
    }

    // Generate onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${FRONTEND_URL}/vendor/stripe-connect?refresh=true`,
      return_url: `${FRONTEND_URL}/vendor/stripe-connect?success=true`,
      type: "account_onboarding",
    });

    return { onboardingUrl: accountLink.url };
  },

  /**
   * Generate a new onboarding link (for when the previous one expired).
   */
  async refresh(userId: string): Promise<{ onboardingUrl: string }> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true, stripeAccountId: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }
    if (!vendor.stripeAccountId) {
      throw new AppError("Stripe account not created yet. Call onboard first.", 400);
    }

    const accountLink = await stripe.accountLinks.create({
      account: vendor.stripeAccountId,
      refresh_url: `${FRONTEND_URL}/vendor/stripe-connect?refresh=true`,
      return_url: `${FRONTEND_URL}/vendor/stripe-connect?success=true`,
      type: "account_onboarding",
    });

    return { onboardingUrl: accountLink.url };
  },

  /**
   * Fetch current Stripe account status and sync to DB.
   */
  async getStatus(userId: string): Promise<{
    stripeAccountId: string | null;
    status: string | null;
    payoutsEnabled: boolean;
    chargesEnabled: boolean;
    onboardedAt: Date | null;
  }> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: {
        id: true,
        stripeAccountId: true,
        stripeAccountStatus: true,
        stripePayoutsEnabled: true,
        stripeChargesEnabled: true,
        stripeOnboardedAt: true,
      },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    // If we have an account, sync status from Stripe
    if (vendor.stripeAccountId) {
      try {
        const account = await stripe.accounts.retrieve(vendor.stripeAccountId);
        const status = this.deriveStatus(account);

        await prisma.vendor.update({
          where: { id: vendor.id },
          data: {
            stripeAccountStatus: status,
            stripePayoutsEnabled: account.payouts_enabled ?? false,
            stripeChargesEnabled: account.charges_enabled ?? false,
            stripeOnboardedAt:
              account.charges_enabled && !vendor.stripeOnboardedAt
                ? new Date()
                : vendor.stripeOnboardedAt,
          },
        });

        return {
          stripeAccountId: vendor.stripeAccountId,
          status,
          payoutsEnabled: account.payouts_enabled ?? false,
          chargesEnabled: account.charges_enabled ?? false,
          onboardedAt:
            account.charges_enabled && !vendor.stripeOnboardedAt
              ? new Date()
              : vendor.stripeOnboardedAt,
        };
      } catch (error) {
        logger.error("Stripe account retrieve failed", {
          vendorId: vendor.id,
          stripeAccountId: vendor.stripeAccountId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      stripeAccountId: vendor.stripeAccountId,
      status: vendor.stripeAccountStatus,
      payoutsEnabled: vendor.stripePayoutsEnabled,
      chargesEnabled: vendor.stripeChargesEnabled,
      onboardedAt: vendor.stripeOnboardedAt,
    };
  },

  /**
   * Handle account.updated webhook from Stripe Connect.
   */
  async handleAccountUpdated(accountId: string): Promise<void> {
    const vendor = await prisma.vendor.findUnique({
      where: { stripeAccountId: accountId },
      select: { id: true, stripeOnboardedAt: true },
    });
    if (!vendor) {
      logger.warn("Stripe Connect webhook: vendor not found for account", { accountId });
      return;
    }

    const account = await stripe.accounts.retrieve(accountId);
    const status = this.deriveStatus(account);

    await prisma.vendor.update({
      where: { id: vendor.id },
      data: {
        stripeAccountStatus: status,
        stripePayoutsEnabled: account.payouts_enabled ?? false,
        stripeChargesEnabled: account.charges_enabled ?? false,
        stripeOnboardedAt:
          account.charges_enabled && !vendor.stripeOnboardedAt
            ? new Date()
            : vendor.stripeOnboardedAt,
      },
    });

    logger.info("Stripe Connect account synced", {
      vendorId: vendor.id,
      accountId,
      status,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
    });
  },

  /**
   * Check if vendor is eligible for payouts via Stripe Connect.
   */
  async isPayoutEligible(vendorId: string): Promise<boolean> {
    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { stripePayoutsEnabled: true, stripeChargesEnabled: true, isSuspended: true },
    });
    if (!vendor) return false;
    return vendor.stripePayoutsEnabled && vendor.stripeChargesEnabled && !vendor.isSuspended;
  },

  deriveStatus(account: { charges_enabled?: boolean; payouts_enabled?: boolean; details_submitted?: boolean }): string {
    if (account.charges_enabled && account.payouts_enabled) return "active";
    if (account.details_submitted) return "pending_verification";
    return "onboarding";
  },
};
