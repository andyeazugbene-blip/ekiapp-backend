-- AlterTable
ALTER TABLE "StripeDispute" ADD COLUMN     "affectedOrderIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "preDisputeStatuses" JSONB;
