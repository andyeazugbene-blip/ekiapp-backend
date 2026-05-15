import type { Request, Response } from "express";
import type { Vendor } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import { buildVendorShareUrl, vendorsService } from "./vendors.service";
import {
  validateCreatePayoutMethodInput,
  validateCreateVendorInput,
  validateUpdateVendorInput,
} from "./vendors.validation";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

/**
 * Add `shareUrl` to a vendor object before it is sent to clients.
 * Wallet (if present) is preserved.
 */
function withShareUrl<T extends Pick<Vendor, "storeSlug">>(vendor: T): T & { shareUrl: string } {
  return { ...vendor, shareUrl: buildVendorShareUrl(vendor.storeSlug) };
}

export async function createVendor(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const input = validateCreateVendorInput(request.body);
  const vendor = await vendorsService.createVendor(userId, input);
  response.status(201).json({ vendor: withShareUrl(vendor) });
}

export async function getOwnVendor(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const vendor = await vendorsService.getOwnVendor(userId);
  response.status(200).json({ vendor: withShareUrl(vendor) });
}

export async function updateOwnVendor(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const input = validateUpdateVendorInput(request.body);
  const vendor = await vendorsService.updateOwnVendor(userId, input);
  response.status(200).json({ vendor: withShareUrl(vendor) });
}

export async function createPayoutMethod(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const input = validateCreatePayoutMethodInput(request.body);
  const payoutMethod = await vendorsService.createPayoutMethod(userId, input);
  response.status(201).json({ payoutMethod });
}

export async function listPayoutMethods(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const payoutMethods = await vendorsService.listPayoutMethods(userId);
  response.status(200).json({ payoutMethods });
}
