-- Diaspora launch seller plans and commission tiers.
-- Existing SubscriptionPlanConfig/VendorSubscription.plan are retained as
-- compatibility fields while the launch model moves to admin-managed plans.

CREATE TABLE "SellerPlan" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "legacyPlan" "SubscriptionPlan",
  "monthlyPriceCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'GBP',
  "stripePriceId" TEXT,
  "stripeProductId" TEXT,
  "defaultPlatformFeeBps" INTEGER NOT NULL DEFAULT 1500,
  "withdrawalFeeBps" INTEGER NOT NULL DEFAULT 250,
  "maxProducts" INTEGER NOT NULL DEFAULT 10,
  "maxImagesPerProduct" INTEGER NOT NULL DEFAULT 3,
  "maxOrders" INTEGER,
  "analytics" BOOLEAN NOT NULL DEFAULT false,
  "prioritySupport" BOOLEAN NOT NULL DEFAULT false,
  "flashSales" BOOLEAN NOT NULL DEFAULT false,
  "bundles" BOOLEAN NOT NULL DEFAULT false,
  "discounts" BOOLEAN NOT NULL DEFAULT false,
  "marketingTools" BOOLEAN NOT NULL DEFAULT false,
  "canReceiveOrders" BOOLEAN NOT NULL DEFAULT true,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SellerPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommissionTier" (
  "id" TEXT NOT NULL,
  "sellerPlanId" TEXT NOT NULL,
  "label" TEXT,
  "minSubtotalCents" INTEGER NOT NULL DEFAULT 0,
  "maxSubtotalCents" INTEGER,
  "platformFeeBps" INTEGER NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommissionTier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SellerPlan_slug_key" ON "SellerPlan"("slug");
CREATE UNIQUE INDEX "SellerPlan_legacyPlan_key" ON "SellerPlan"("legacyPlan");
CREATE INDEX "SellerPlan_isActive_deletedAt_displayOrder_idx" ON "SellerPlan"("isActive", "deletedAt", "displayOrder");
CREATE INDEX "SellerPlan_legacyPlan_idx" ON "SellerPlan"("legacyPlan");
CREATE INDEX "CommissionTier_sellerPlanId_isActive_minSubtotalCents_idx" ON "CommissionTier"("sellerPlanId", "isActive", "minSubtotalCents");

ALTER TABLE "CommissionTier"
  ADD CONSTRAINT "CommissionTier_sellerPlanId_fkey"
  FOREIGN KEY ("sellerPlanId") REFERENCES "SellerPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VendorSubscription" ADD COLUMN "sellerPlanId" TEXT;
ALTER TABLE "Order" ADD COLUMN "sellerPlanId" TEXT;
ALTER TABLE "Order" ADD COLUMN "sellerPlanSlug" TEXT;
ALTER TABLE "Order" ADD COLUMN "commissionTierId" TEXT;
ALTER TABLE "Order" ADD COLUMN "commissionBps" INTEGER;
ALTER TABLE "Order" ADD COLUMN "withdrawalFeeBps" INTEGER;
ALTER TABLE "Payment" ADD COLUMN "sellerPlanId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "sellerPlanSlug" TEXT;
ALTER TABLE "Payment" ADD COLUMN "commissionTierId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "commissionBps" INTEGER;
ALTER TABLE "Payment" ADD COLUMN "withdrawalFeeBps" INTEGER;
ALTER TABLE "PayoutRequest" ADD COLUMN "withdrawalFeeAmount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PayoutRequest" ADD COLUMN "withdrawalFeeBps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PayoutRequest" ADD COLUMN "netAmount" INTEGER;

INSERT INTO "SellerPlan" (
  "id", "slug", "name", "description", "legacyPlan", "monthlyPriceCents",
  "currency", "defaultPlatformFeeBps", "withdrawalFeeBps", "maxProducts",
  "maxImagesPerProduct", "analytics", "prioritySupport", "flashSales",
  "bundles", "discounts", "marketingTools", "canReceiveOrders",
  "isActive", "displayOrder"
) VALUES
  (
    'seller_plan_starter', 'starter', 'Starter',
    'Default diaspora seller plan for all newly verified vendors.',
    'FREE', 0, 'GBP', 1500, 250, 25, 5,
    false, false, false, false, false, false, true, true, 0
  ),
  (
    'seller_plan_growth', 'growth', 'Growth',
    'Lower commission and marketing tools for approved or high-performing vendors.',
    'GROWTH', 2999, 'GBP', 1000, 200, 100, 10,
    true, false, true, true, true, true, true, true, 10
  ),
  (
    'seller_plan_pro', 'pro', 'Pro',
    'Advanced seller plan with admin-configurable custom fees and priority support.',
    'PRO', 7999, 'GBP', 800, 150, -1, 30,
    true, true, true, true, true, true, true, true, 20
  );

INSERT INTO "CommissionTier" (
  "id", "sellerPlanId", "label", "minSubtotalCents", "maxSubtotalCents",
  "platformFeeBps", "isActive", "displayOrder"
) VALUES
  ('commission_tier_starter_default', 'seller_plan_starter', 'Starter default', 0, NULL, 1500, true, 0),
  ('commission_tier_growth_default', 'seller_plan_growth', 'Growth default', 0, NULL, 1000, true, 0),
  ('commission_tier_pro_default', 'seller_plan_pro', 'Pro default', 0, NULL, 800, true, 0);

UPDATE "VendorSubscription"
SET "sellerPlanId" = CASE
  WHEN "plan" = 'GROWTH' THEN 'seller_plan_growth'
  WHEN "plan" IN ('PRO', 'PREMIUM') THEN 'seller_plan_pro'
  ELSE 'seller_plan_starter'
END
WHERE "sellerPlanId" IS NULL;

UPDATE "Order"
SET
  "sellerPlanId" = CASE
    WHEN "platformFeeAmount" > 0 AND "subtotalAmount" > 0 AND ROUND(("platformFeeAmount"::numeric / "subtotalAmount"::numeric) * 10000) <= 1000 THEN 'seller_plan_growth'
    ELSE 'seller_plan_starter'
  END,
  "sellerPlanSlug" = CASE
    WHEN "platformFeeAmount" > 0 AND "subtotalAmount" > 0 AND ROUND(("platformFeeAmount"::numeric / "subtotalAmount"::numeric) * 10000) <= 1000 THEN 'growth'
    ELSE 'starter'
  END,
  "commissionTierId" = CASE
    WHEN "platformFeeAmount" > 0 AND "subtotalAmount" > 0 AND ROUND(("platformFeeAmount"::numeric / "subtotalAmount"::numeric) * 10000) <= 1000 THEN 'commission_tier_growth_default'
    ELSE 'commission_tier_starter_default'
  END,
  "commissionBps" = CASE
    WHEN "subtotalAmount" > 0 THEN ROUND(("platformFeeAmount"::numeric / "subtotalAmount"::numeric) * 10000)::integer
    ELSE NULL
  END,
  "withdrawalFeeBps" = CASE
    WHEN "platformFeeAmount" > 0 AND "subtotalAmount" > 0 AND ROUND(("platformFeeAmount"::numeric / "subtotalAmount"::numeric) * 10000) <= 1000 THEN 200
    ELSE 250
  END;

UPDATE "Payment"
SET
  "sellerPlanId" = "Order"."sellerPlanId",
  "sellerPlanSlug" = "Order"."sellerPlanSlug",
  "commissionTierId" = "Order"."commissionTierId",
  "commissionBps" = "Order"."commissionBps",
  "withdrawalFeeBps" = "Order"."withdrawalFeeBps"
FROM "Order"
WHERE "Payment"."orderId" = "Order"."id";

CREATE INDEX "VendorSubscription_sellerPlanId_idx" ON "VendorSubscription"("sellerPlanId");
CREATE INDEX "Order_sellerPlanId_idx" ON "Order"("sellerPlanId");
CREATE INDEX "Order_commissionTierId_idx" ON "Order"("commissionTierId");
CREATE INDEX "Payment_sellerPlanId_idx" ON "Payment"("sellerPlanId");
CREATE INDEX "Payment_commissionTierId_idx" ON "Payment"("commissionTierId");

ALTER TABLE "VendorSubscription"
  ADD CONSTRAINT "VendorSubscription_sellerPlanId_fkey"
  FOREIGN KEY ("sellerPlanId") REFERENCES "SellerPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_sellerPlanId_fkey"
  FOREIGN KEY ("sellerPlanId") REFERENCES "SellerPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_commissionTierId_fkey"
  FOREIGN KEY ("commissionTierId") REFERENCES "CommissionTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_sellerPlanId_fkey"
  FOREIGN KEY ("sellerPlanId") REFERENCES "SellerPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_commissionTierId_fkey"
  FOREIGN KEY ("commissionTierId") REFERENCES "CommissionTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
