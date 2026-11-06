ALTER TABLE "CommunicationLog" ADD COLUMN "openedAt" TIMESTAMP(3),
ADD COLUMN "clickedAt" TIMESTAMP(3);

CREATE INDEX "CommunicationLog_providerRef_idx" ON "CommunicationLog"("providerRef");
