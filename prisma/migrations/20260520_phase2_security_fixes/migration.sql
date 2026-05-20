-- Phase 2: Review rating CHECK constraint
ALTER TABLE "Review" ADD CONSTRAINT "Review_rating_range" CHECK ("rating" BETWEEN 1 AND 5);

-- Phase 2: PromoCode usedCount cannot go negative
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_usedCount_non_negative" CHECK ("usedCount" >= 0);
