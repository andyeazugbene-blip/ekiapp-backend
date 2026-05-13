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
