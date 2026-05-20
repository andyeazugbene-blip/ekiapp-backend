import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
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

// ─── Admin Endpoints ─────────────────────────────────────────────────────────

export async function adminListPendingDocuments(
  _request: Request,
  response: Response,
): Promise<void> {
  const documents = await verificationService.adminListPendingDocuments();
  response.status(200).json({ documents });
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
