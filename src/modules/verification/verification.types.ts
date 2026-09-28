import type { VerificationDocType } from "@prisma/client";

export interface SubmitVerificationInput {
  type: VerificationDocType;
  idType?: string; // passport, drivers_license, national_id
  frontUrl: string;
  backUrl?: string;
}

export interface ReviewVerificationInput {
  status: "APPROVED" | "REJECTED";
  rejectionReason?: string;
}

/**
 * A vendor verifies either through Stripe Identity (the current, live path
 * every real vendor goes through — see stripe-identity.service.ts) or by
 * uploading documents for manual admin review (submitVerificationDocument()
 * below — legacy; no screen in the app calls it any more, but existing rows
 * from before Stripe Identity shipped still need to be reviewable). A vendor
 * could in principle have attempted both.
 */
export type VerificationMethod = "STRIPE_IDENTITY" | "MANUAL_DOCUMENTS" | "BOTH";
