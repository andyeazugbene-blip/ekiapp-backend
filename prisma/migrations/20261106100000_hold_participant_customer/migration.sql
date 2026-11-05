-- Stripe only reuses a saved card off-session when it belongs to a Customer. Nullable: no existing rows change.
ALTER TABLE "CommunityBuyPaymentAuthorisation" ADD COLUMN "stripeCustomerId" TEXT;
