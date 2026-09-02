-- AlterTable
ALTER TABLE "OrganiserProfile" ADD COLUMN     "isRestricted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "restrictedReason" TEXT;

-- AlterTable
ALTER TABLE "SupplierProfile" ADD COLUMN     "isRestricted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "restrictedReason" TEXT;
