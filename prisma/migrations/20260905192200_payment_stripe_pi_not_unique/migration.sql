-- Payment.stripePaymentIntentId must not be unique: a multi-vendor checkout
-- creates exactly ONE Stripe PaymentIntent shared across every vendor's
-- Order/Payment row (see payments.service.ts createPaymentIntent).
-- Checkout.stripePaymentIntentId (its own separate unique column) is the
-- real unique identifier for "this PaymentIntent" — this column is only a
-- denormalized per-order copy used for lookups/refunds.
--
-- With the old unique index, the Stripe webhook's per-order update loop
-- (stripe.service.ts processPaymentSucceeded) threw a unique-constraint
-- violation on the SECOND order on any real 2+-vendor Stripe checkout,
-- rolling back the whole transaction — every vendor after the first stayed
-- stuck PENDING and never got credited, despite the buyer having paid.

DROP INDEX "Payment_stripePaymentIntentId_key";
CREATE INDEX "Payment_stripePaymentIntentId_idx" ON "Payment"("stripePaymentIntentId");
