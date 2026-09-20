-- AlterTable
ALTER TABLE "OrganiserProfile" ADD COLUMN     "stripeDisabledReason" TEXT,
ADD COLUMN     "stripeRequirementsCurrentlyDue" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "stripeRequirementsEventuallyDue" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "stripeRequirementsPastDue" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "stripeStatusFetchedAt" TIMESTAMP(3);
