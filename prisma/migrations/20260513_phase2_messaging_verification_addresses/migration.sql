-- Phase 2: Messaging, Verification Documents, Buyer Addresses

-- Enums
CREATE TYPE "ConversationType" AS ENUM ('BUYER_VENDOR', 'ADMIN_VENDOR', 'DISPUTE');
CREATE TYPE "VerificationDocType" AS ENUM ('GOVERNMENT_ID', 'BUSINESS_REGISTRATION');
CREATE TYPE "VerificationDocStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- Conversation
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "type" "ConversationType" NOT NULL DEFAULT 'BUYER_VENDOR',
    "participantA" TEXT NOT NULL,
    "participantB" TEXT NOT NULL,
    "orderId" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Conversation_participantA_participantB_orderId_key" ON "Conversation"("participantA", "participantB", "orderId");
CREATE INDEX "Conversation_participantA_lastMessageAt_idx" ON "Conversation"("participantA", "lastMessageAt");
CREATE INDEX "Conversation_participantB_lastMessageAt_idx" ON "Conversation"("participantB", "lastMessageAt");
CREATE INDEX "Conversation_orderId_idx" ON "Conversation"("orderId");

-- Message
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "attachments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
CREATE INDEX "Message_senderId_idx" ON "Message"("senderId");

ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- VerificationDocument
CREATE TABLE "VerificationDocument" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "type" "VerificationDocType" NOT NULL,
    "idType" TEXT,
    "frontUrl" TEXT NOT NULL,
    "backUrl" TEXT,
    "status" "VerificationDocStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VerificationDocument_vendorId_type_idx" ON "VerificationDocument"("vendorId", "type");
CREATE INDEX "VerificationDocument_status_idx" ON "VerificationDocument"("status");

-- BuyerAddress
CREATE TABLE "BuyerAddress" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "phone" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuyerAddress_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BuyerAddress_buyerId_idx" ON "BuyerAddress"("buyerId");
