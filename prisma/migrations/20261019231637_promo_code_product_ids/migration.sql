-- AlterTable
ALTER TABLE "PromoCode" ADD COLUMN     "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
