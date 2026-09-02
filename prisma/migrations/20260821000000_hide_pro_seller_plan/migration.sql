-- Growth is now the only paid vendor plan offered on signup/upgrade.
-- Deactivating "pro" removes it from the public plan picker
-- (subscriptionsService.listPublicPlans filters isActive = true) without
-- touching any vendor already assigned to it: VendorSubscription rows keep
-- their sellerPlanId and getPlanForSubscription() resolves plans by id
-- regardless of isActive, so existing Pro subscribers keep their current
-- features/pricing unchanged. Admins can still reactivate or assign this
-- plan manually (findSellerPlan/assignVendorPlan both query with
-- includeInactive = true).
UPDATE "SellerPlan" SET "isActive" = false WHERE "slug" = 'pro' AND "deletedAt" IS NULL;
