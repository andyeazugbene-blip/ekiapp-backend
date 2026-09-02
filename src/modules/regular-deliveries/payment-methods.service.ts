import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";

/**
 * Buyer saved payment methods (SetupIntent flow). Nothing like this
 * existed before Regular Deliveries — normal checkout is always one-shot.
 * Reuses the same Stripe account already used for checkout and vendor
 * Connect payouts.
 */
export const buyerPaymentMethodsService = {
  async createSetupIntent(buyerId: string): Promise<{ clientSecret: string; customerId: string }> {
    const buyer = await prisma.user.findUnique({ where: { id: buyerId }, select: { email: true, name: true } });
    if (!buyer) throw new AppError("Buyer not found", 404);

    // Reuse a customer if this buyer already saved a card before.
    const existing = await prisma.buyerPaymentMethod.findFirst({ where: { buyerId }, select: { stripeCustomerId: true } });
    let customerId = existing?.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: buyer.email, name: buyer.name, metadata: { buyerId } });
      customerId = customer.id;
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      metadata: { buyerId },
    });

    if (!setupIntent.client_secret) throw new AppError("Failed to start card setup", 502);
    return { clientSecret: setupIntent.client_secret, customerId };
  },

  /**
   * Called after the buyer's app confirms the SetupIntent client-side.
   * Verifies the SetupIntent server-side (never trusts the client alone)
   * before persisting the payment method.
   */
  async confirmSetupIntent(buyerId: string, setupIntentId: string): Promise<{ id: string }> {
    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    if (setupIntent.metadata?.buyerId !== buyerId) throw new AppError("Forbidden", 403);
    if (setupIntent.status !== "succeeded") {
      throw new AppError("Card setup was not completed", 400);
    }
    if (!setupIntent.payment_method || typeof setupIntent.customer !== "string") {
      throw new AppError("Card setup did not return a usable payment method", 502);
    }
    const paymentMethodId =
      typeof setupIntent.payment_method === "string" ? setupIntent.payment_method : setupIntent.payment_method.id;

    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);

    const hasExisting = await prisma.buyerPaymentMethod.findFirst({ where: { buyerId }, select: { id: true } });

    const saved = await prisma.buyerPaymentMethod.create({
      data: {
        buyerId,
        stripeCustomerId: setupIntent.customer,
        stripePaymentMethodId: paymentMethodId,
        brand: pm.card?.brand,
        last4: pm.card?.last4,
        isDefault: !hasExisting,
      },
    });
    return { id: saved.id };
  },

  async list(buyerId: string) {
    return prisma.buyerPaymentMethod.findMany({ where: { buyerId }, orderBy: { createdAt: "desc" } });
  },

  async remove(buyerId: string, id: string): Promise<void> {
    const pm = await prisma.buyerPaymentMethod.findUnique({ where: { id } });
    if (!pm || pm.buyerId !== buyerId) throw new AppError("Payment method not found", 404);
    const activeSubscriptions = await prisma.buyerSubscription.count({
      where: { paymentMethodId: id, status: { in: ["ACTIVE", "PAYMENT_ATTENTION"] } },
    });
    if (activeSubscriptions > 0) {
      throw new AppError("This card is in use by an active Regular Delivery. Update the subscription first.", 409);
    }
    await stripe.paymentMethods.detach(pm.stripePaymentMethodId).catch(() => {});
    await prisma.buyerPaymentMethod.delete({ where: { id } });
  },
};
