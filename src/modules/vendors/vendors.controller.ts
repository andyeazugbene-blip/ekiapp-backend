import type { Request, Response } from "express";
import type { Vendor } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { authService } from "../auth/auth.service";
import { buildVendorShareUrl, vendorsService } from "./vendors.service";
import {
  validateCreatePayoutMethodInput,
  validateCreateVendorInput,
  validateUpdatePayoutMethodInput,
  validateUpdateVendorInput,
} from "./vendors.validation";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) throw new AppError("Invalid id", 400);
  return id;
}

/**
 * Add `shareUrl` to a vendor object before it is sent to clients.
 */
function withShareUrl<T extends Pick<Vendor, "storeSlug">>(vendor: T): T & { shareUrl: string } {
  return { ...vendor, shareUrl: buildVendorShareUrl(vendor.storeSlug) };
}

export async function listPublicVendors(request: Request, response: Response): Promise<void> {
  const limit = Number(request.query.limit) || 20;
  const search = typeof request.query.search === "string" ? request.query.search : undefined;
  const sort = request.query.sort === "newest" ? "newest" : "popular";
  const vendors = await vendorsService.listPublicVendors({ limit, search, sort });
  response.status(200).json({ items: vendors.map((vendor) => withShareUrl(vendor)) });
}

export async function getPublicVendor(request: Request, response: Response): Promise<void> {
  const id = typeof request.params.id === "string" ? request.params.id : "";
  if (!id) {
    throw new AppError("Invalid id", 400);
  }
  const vendor = await vendorsService.getPublicVendorById(id);
  response.status(200).json({ vendor: withShareUrl(vendor) });
}

export async function createVendor(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const input = validateCreateVendorInput(request.body);
  const vendor = await vendorsService.createVendor(userId, input);

  // Issue a fresh JWT with the updated VENDOR role so the frontend
  // does not need to re-login after vendor creation.
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, role: true, email: true, tokenVersion: true },
  });
  const token = authService.signTokenPublic(user);

  response.status(201).json({ vendor: withShareUrl(vendor), token });
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

export async function updatePayoutMethod(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const methodId = requireIdParam(request);
  const input = validateUpdatePayoutMethodInput(request.body);
  const payoutMethod = await vendorsService.updatePayoutMethod(userId, methodId, input);
  response.status(200).json({ payoutMethod });
}

export async function deletePayoutMethod(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  await vendorsService.deletePayoutMethod(userId, requireIdParam(request));
  response.status(200).json({ message: "Payout method deleted" });
}

export async function setDefaultPayoutMethod(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const payoutMethod = await vendorsService.setDefaultPayoutMethod(userId, requireIdParam(request));
  response.status(200).json({ payoutMethod });
}
