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

export type ConnectAccountLike = {
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  requirements?: {
    currently_due?: string[] | null;
    past_due?: string[] | null;
    eventually_due?: string[] | null;
    disabled_reason?: string | null;
    current_deadline?: number | null;
  } | null;
};

function deriveStatus(account: ConnectAccountLike): string {
  if (account.charges_enabled && account.payouts_enabled) return "active";
  const disabled = account.requirements?.disabled_reason;
  if (
    disabled &&
    disabled !== "requirements.pending_verification" &&
    disabled !== "under_review" &&
    account.details_submitted
  ) {
    return "restricted";
  }
  if (account.details_submitted) return "pending_verification";
  return "onboarding";
}

/**
 * Handbook 5.1 / 14.7: the single mapping from a Stripe Account object to the
 * provider-owned Vendor columns, shared by the self-service status poll, the
 * admin live refresh and the account.updated webhook so they never drift.
 * Requirement keys are Stripe field-name identifiers, never values.
 */
export function deriveVendorConnectFields(account: ConnectAccountLike) {
  const deadline = account.requirements?.current_deadline;
  return {
    stripeAccountStatus: deriveStatus(account),
    stripePayoutsEnabled: account.payouts_enabled ?? false,
    stripeChargesEnabled: account.charges_enabled ?? false,
    stripeRequirementsCurrentlyDue: account.requirements?.currently_due ?? [],
    stripeRequirementsPastDue: account.requirements?.past_due ?? [],
    stripeRequirementsEventuallyDue: account.requirements?.eventually_due ?? [],
    stripeDisabledReason: account.requirements?.disabled_reason ?? null,
    stripeRequirementsDeadline: typeof deadline === "number" ? new Date(deadline * 1000) : null,
    stripeStatusFetchedAt: new Date(),
  };
}

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
        const fields = deriveVendorConnectFields(account);
        const onboardedAt =
          account.charges_enabled && !vendor.stripeOnboardedAt ? new Date() : vendor.stripeOnboardedAt;

        await prisma.vendor.update({
          where: { id: vendor.id },
          data: { ...fields, stripeOnboardedAt: onboardedAt },
        });

        return {
          stripeAccountId: vendor.stripeAccountId,
          status: fields.stripeAccountStatus,
          payoutsEnabled: fields.stripePayoutsEnabled,
          chargesEnabled: fields.stripeChargesEnabled,
          onboardedAt,
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
   * Handle account.updated for a VENDOR connected account (webhook or admin
   * refresh). Returns { handled: false } when the account belongs to no vendor
   * so the webhook router can treat it as a safe no-op. Uses the account
   * object delivered in the event when given (no extra API call) and only
   * retrieve()s when just an id is supplied. Throws on DB/API failure so the
   * webhook layer can release its idempotency claim and let Stripe retry.
   */
  async handleAccountUpdated(
    accountOrId: string | (ConnectAccountLike & { id: string }),
  ): Promise<{ handled: boolean }> {
    const accountId = typeof accountOrId === "string" ? accountOrId : accountOrId.id;
    const vendor = await prisma.vendor.findUnique({
      where: { stripeAccountId: accountId },
      select: { id: true, stripeOnboardedAt: true },
    });
    if (!vendor) {
      logger.info("Stripe Connect webhook: no vendor for account", { accountId });
      return { handled: false };
    }

    const account: ConnectAccountLike =
      typeof accountOrId === "string" ? await stripe.accounts.retrieve(accountId) : accountOrId;
    const fields = deriveVendorConnectFields(account);

    await prisma.vendor.update({
      where: { id: vendor.id },
      data: {
        ...fields,
        stripeOnboardedAt:
          account.charges_enabled && !vendor.stripeOnboardedAt ? new Date() : vendor.stripeOnboardedAt,
      },
    });

    logger.info("Stripe Connect account synced", {
      vendorId: vendor.id,
      accountId,
      status: fields.stripeAccountStatus,
      chargesEnabled: fields.stripeChargesEnabled,
      payoutsEnabled: fields.stripePayoutsEnabled,
      disabledReason: fields.stripeDisabledReason,
    });
    return { handled: true };
  },

  /**
   * account.application.deauthorized: the vendor disconnected the account from
   * Eki. Keep stripeAccountId (history + webhook lookup) but switch off
   * charges/payouts so no money is routed to it, and mark the status so the
   * admin readiness panel shows it as restricted/disconnected.
   */
  async handleAccountDeauthorized(accountId: string): Promise<{ handled: boolean }> {
    const vendor = await prisma.vendor.findUnique({
      where: { stripeAccountId: accountId },
      select: { id: true },
    });
    if (!vendor) {
      logger.info("Stripe Connect deauthorized webhook: no vendor for account", { accountId });
      return { handled: false };
    }
    await prisma.vendor.update({
      where: { id: vendor.id },
      data: {
        stripeAccountStatus: "deauthorized",
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
        stripeStatusFetchedAt: new Date(),
      },
    });
    logger.warn("Stripe Connect account deauthorized by vendor", { vendorId: vendor.id, accountId });
    return { handled: true };
  },

  /**
   * Admin-triggered live refresh (GET /admin/vendors/:id/stripe-status?refresh=true).
   * Never disguises a failed live read as fresh: returns an error so the caller
   * can show stored data with a warning.
   */
  async refreshFromStripeForAdmin(vendorId: string): Promise<{ refreshed: boolean; error?: string }> {
    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, stripeAccountId: true },
    });
    if (!vendor?.stripeAccountId) return { refreshed: false };
    try {
      const result = await this.handleAccountUpdated(vendor.stripeAccountId);
      return { refreshed: result.handled };
    } catch (error) {
      logger.error("Admin Stripe account refresh failed", {
        vendorId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return { refreshed: false, error: "Could not reach Stripe. Showing the last stored state." };
    }
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

  deriveStatus(account: ConnectAccountLike): string {
    return deriveStatus(account);
  },
};
