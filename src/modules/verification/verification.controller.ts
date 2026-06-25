import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { verificationService } from "./verification.service";
import {
  validateReviewVerificationInput,
  validateSubmitVerificationInput,
} from "./verification.validation";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new AppError("Invalid id", 400);
  }
  return id;
}

// ─── Vendor Endpoints ────────────────────────────────────────────────────────

export async function submitVerificationDocument(
  request: Request,
  response: Response,
): Promise<void> {
  const input = validateSubmitVerificationInput(request.body);
  const document = await verificationService.submitDocument(requireUserId(request), input);
  response.status(201).json({ document });
}

export async function getOwnVerification(
  request: Request,
  response: Response,
): Promise<void> {
  const result = await verificationService.getOwnVerification(requireUserId(request));
  response.status(200).json(result);
}

export async function resetVerification(
  request: Request,
  response: Response,
): Promise<void> {
  await verificationService.resetPendingDocuments(requireUserId(request));
  response.status(200).json({ message: "Pending documents cleared" });
}

// ─── Admin Endpoints ─────────────────────────────────────────────────────────

export async function adminListPendingDocuments(
  request: Request,
  response: Response,
): Promise<void> {
  const status = typeof request.query.status === "string" ? request.query.status : undefined;
  const documents = await verificationService.adminListPendingDocuments(status);
  response.status(200).json({ documents });
}

export async function adminListVerificationQueue(
  request: Request,
  response: Response,
): Promise<void> {
  const result = await verificationService.adminListReviewQueue(request.query as Record<string, unknown>);
  response.status(200).json(result);
}

export async function adminGetVerificationReview(
  request: Request,
  response: Response,
): Promise<void> {
  const result = await verificationService.adminGetReviewDetails(requireIdParam(request));
  response.status(200).json(result);
}

export async function adminApproveVerificationReview(
  request: Request,
  response: Response,
): Promise<void> {
  const vendorId = requireIdParam(request);
  const result = await verificationService.adminApproveVendorVerification(
    requireUserId(request),
    vendorId,
  );
  await recordAudit({
    actorId: requireUserId(request),
    action: "verification.approve",
    entityType: "Vendor",
    entityId: vendorId,
  });
  response.status(200).json(result);
}

export async function adminRejectVerificationReview(
  request: Request,
  response: Response,
): Promise<void> {
  const vendorId = requireIdParam(request);
  const reason =
    typeof request.body?.rejectionReason === "string"
      ? request.body.rejectionReason
      : typeof request.body?.reason === "string"
        ? request.body.reason
        : "";
  const result = await verificationService.adminRejectVendorVerification(
    requireUserId(request),
    vendorId,
    reason,
  );
  await recordAudit({
    actorId: requireUserId(request),
    action: "verification.reject",
    entityType: "Vendor",
    entityId: vendorId,
    metadata: { rejectionReason: reason },
  });
  response.status(200).json(result);
}

export async function adminDeleteVerificationFiles(
  request: Request,
  response: Response,
): Promise<void> {
  const vendorId = requireIdParam(request);
  const result = await verificationService.adminDeleteVendorVerificationFiles(vendorId);
  await recordAudit({
    actorId: requireUserId(request),
    action: "verification.files.delete",
    entityType: "Vendor",
    entityId: vendorId,
    metadata: { deletedDocuments: result.deletedDocuments, failedDocuments: result.failedDocuments },
  });
  response.status(200).json(result);
}

export async function adminReviewDocument(
  request: Request,
  response: Response,
): Promise<void> {
  const input = validateReviewVerificationInput(request.body);
  const document = await verificationService.adminReviewDocument(
    requireUserId(request),
    requireIdParam(request),
    input,
  );
  response.status(200).json({ document });
}
