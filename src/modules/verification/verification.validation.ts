import { VerificationDocType } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import type { ReviewVerificationInput, SubmitVerificationInput } from "./verification.types";

const DOC_TYPES = new Set<string>(Object.values(VerificationDocType));
const ID_TYPES = new Set(["passport", "drivers_license", "national_id"]);

export function validateSubmitVerificationInput(input: unknown): SubmitVerificationInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.type !== "string" || !DOC_TYPES.has(raw.type)) {
    throw new AppError("Invalid document type (GOVERNMENT_ID, BUSINESS_REGISTRATION)", 400);
  }

  if (raw.type === "GOVERNMENT_ID") {
    if (typeof raw.idType !== "string" || !ID_TYPES.has(raw.idType)) {
      throw new AppError("Invalid idType (passport, drivers_license, national_id)", 400);
    }
  }

  if (typeof raw.frontUrl !== "string" || raw.frontUrl.trim().length === 0) {
    throw new AppError("frontUrl is required", 400);
  }

  const backUrl =
    typeof raw.backUrl === "string" && raw.backUrl.trim().length > 0
      ? raw.backUrl.trim()
      : undefined;

  return {
    type: raw.type as VerificationDocType,
    idType: typeof raw.idType === "string" ? raw.idType : undefined,
    frontUrl: raw.frontUrl.trim(),
    backUrl,
  };
}

export function validateReviewVerificationInput(input: unknown): ReviewVerificationInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  if (raw.status !== "APPROVED" && raw.status !== "REJECTED") {
    throw new AppError("Status must be APPROVED or REJECTED", 400);
  }

  if (raw.status === "REJECTED") {
    if (typeof raw.rejectionReason !== "string" || raw.rejectionReason.trim().length === 0) {
      throw new AppError("rejectionReason is required when rejecting", 400);
    }
  }

  return {
    status: raw.status,
    rejectionReason:
      typeof raw.rejectionReason === "string" ? raw.rejectionReason.trim() : undefined,
  };
}
