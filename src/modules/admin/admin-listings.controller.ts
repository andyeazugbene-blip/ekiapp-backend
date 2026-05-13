import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { adminListingsService } from "./admin-listings.service";

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new AppError("Invalid id", 400);
  }
  return id;
}

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

function q(request: Request): Record<string, unknown> {
  return request.query as Record<string, unknown>;
}

export async function listUsers(request: Request, response: Response): Promise<void> {
  response.status(200).json(await adminListingsService.listUsers(q(request)));
}

export async function listVendors(request: Request, response: Response): Promise<void> {
  response.status(200).json(await adminListingsService.listVendors(q(request)));
}

export async function listProducts(request: Request, response: Response): Promise<void> {
  response.status(200).json(await adminListingsService.listProducts(q(request)));
}

export async function listOrders(request: Request, response: Response): Promise<void> {
  response.status(200).json(await adminListingsService.listOrders(q(request)));
}

export async function listPayments(request: Request, response: Response): Promise<void> {
  response.status(200).json(await adminListingsService.listPayments(q(request)));
}

export async function listWalletTransactions(
  request: Request,
  response: Response,
): Promise<void> {
  response.status(200).json(await adminListingsService.listWalletTransactions(q(request)));
}

export async function approveVendor(request: Request, response: Response): Promise<void> {
  const vendorId = requireIdParam(request);
  const vendor = await adminListingsService.approveVendor(vendorId);
  await recordAudit({
    actorId: requireUserId(request),
    action: "vendor.approve",
    entityType: "Vendor",
    entityId: vendorId,
  });
  response.status(200).json({ vendor });
}

export async function rejectVendor(request: Request, response: Response): Promise<void> {
  const vendorId = requireIdParam(request);
  const vendor = await adminListingsService.rejectVendor(vendorId);
  await recordAudit({
    actorId: requireUserId(request),
    action: "vendor.reject",
    entityType: "Vendor",
    entityId: vendorId,
  });
  response.status(200).json({ vendor });
}

export async function approveProduct(request: Request, response: Response): Promise<void> {
  const productId = requireIdParam(request);
  const product = await adminListingsService.approveProduct(productId);
  await recordAudit({
    actorId: requireUserId(request),
    action: "product.approve",
    entityType: "Product",
    entityId: productId,
  });
  response.status(200).json({ product });
}

export async function disableProduct(request: Request, response: Response): Promise<void> {
  const productId = requireIdParam(request);
  const product = await adminListingsService.disableProduct(productId);
  await recordAudit({
    actorId: requireUserId(request),
    action: "product.disable",
    entityType: "Product",
    entityId: productId,
  });
  response.status(200).json({ product });
}
