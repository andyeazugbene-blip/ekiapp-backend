import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { adminVendorsService } from "./admin-vendors.service";

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

export async function suspendVendor(request: Request, response: Response): Promise<void> {
  const reason =
    request.body && typeof request.body === "object" && typeof request.body.reason === "string"
      ? request.body.reason.trim()
      : undefined;

  const vendor = await adminVendorsService.suspendVendor(
    requireUserId(request),
    requireIdParam(request),
    reason,
    request,
  );
  response.status(200).json({ vendor });
}

export async function unsuspendVendor(request: Request, response: Response): Promise<void> {
  const reason =
    request.body && typeof request.body === "object" && typeof request.body.reason === "string"
      ? request.body.reason.trim()
      : undefined;

  const vendor = await adminVendorsService.unsuspendVendor(
    requireUserId(request),
    requireIdParam(request),
    reason,
    request,
  );
  response.status(200).json({ vendor });
}

export async function inviteVendor(request: Request, response: Response): Promise<void> {
  const email =
    request.body && typeof request.body === "object" && typeof request.body.email === "string"
      ? request.body.email
      : "";
  const result = await adminVendorsService.inviteVendor(requireUserId(request), email);
  response.status(200).json(result);
}
