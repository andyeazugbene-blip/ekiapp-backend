-- Holds Expo push ticket ids until a delayed receipt check (see
-- checkPushReceipts in src/lib/expo-push.ts) confirms real APNs/FCM
-- delivery status — a ticket status of "ok" only means Expo queued the
-- request, not that it was actually delivered.
CREATE TABLE "PushTicket" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushTicket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushTicket_ticketId_key" ON "PushTicket"("ticketId");
CREATE INDEX "PushTicket_createdAt_idx" ON "PushTicket"("createdAt");
