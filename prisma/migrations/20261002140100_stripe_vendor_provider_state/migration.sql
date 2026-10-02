-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "stripeIdentityStatus" TEXT,
ADD COLUMN     "stripeIdentityUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "stripeReminderSentAt" TIMESTAMP(3);
