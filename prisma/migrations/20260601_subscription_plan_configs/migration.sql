CREATE TABLE "SubscriptionPlanConfig" (
  "id" TEXT NOT NULL,
  "plan" "SubscriptionPlan" NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "monthlyPriceCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'GBP',
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
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SubscriptionPlanConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubscriptionPlanConfig_plan_key" ON "SubscriptionPlanConfig"("plan");
CREATE UNIQUE INDEX "SubscriptionPlanConfig_slug_key" ON "SubscriptionPlanConfig"("slug");
CREATE INDEX "SubscriptionPlanConfig_isActive_displayOrder_idx"
  ON "SubscriptionPlanConfig"("isActive", "displayOrder");
