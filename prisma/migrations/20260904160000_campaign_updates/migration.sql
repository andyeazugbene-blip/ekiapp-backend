-- Real, campaign-wide organiser/supplier broadcast updates (audit gap
-- closure pass). Previously "campaign updates" was only a read over the
-- caller's own per-user Notification rows — there was no way for an
-- organiser or supplier to author one. Communication content only: no
-- financial field exists on this table.

-- CreateEnum
CREATE TYPE "CampaignUpdateAuthorRole" AS ENUM ('ORGANISER', 'SUPPLIER', 'SYSTEM');

-- CreateTable
CREATE TABLE "CampaignUpdate" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorRole" "CampaignUpdateAuthorRole" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignUpdate_campaignId_createdAt_idx" ON "CampaignUpdate"("campaignId", "createdAt");

-- AddForeignKey
ALTER TABLE "CampaignUpdate" ADD CONSTRAINT "CampaignUpdate_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunityCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
