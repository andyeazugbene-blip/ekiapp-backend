-- Email OTP verification table
CREATE TABLE "EmailOtp" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'vendor_onboarding_email',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailOtp_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailOtp_email_purpose_createdAt_idx" ON "EmailOtp"("email", "purpose", "createdAt");
CREATE INDEX "EmailOtp_expiresAt_idx" ON "EmailOtp"("expiresAt");

-- Add emailVerifiedAt to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
