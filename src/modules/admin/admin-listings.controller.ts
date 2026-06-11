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

export async function getUser(request: Request, response: Response): Promise<void> {
  const userId = requireIdParam(request);
  const user = await adminListingsService.getUser(userId);
  response.status(200).json({ user });
}

export async function suspendUser(request: Request, response: Response): Promise<void> {
  const userId = requireIdParam(request);
  const reason = typeof request.body?.reason === "string" ? request.body.reason.trim() : undefined;
  const user = await adminListingsService.suspendUser(userId, reason);
  await recordAudit({
    actorId: requireUserId(request),
    action: "user.suspend",
    entityType: "User",
    entityId: userId,
    metadata: { reason: reason ?? null, role: user.role },
  });
  response.status(200).json({ user });
}

export async function unsuspendUser(request: Request, response: Response): Promise<void> {
  const userId = requireIdParam(request);
  const user = await adminListingsService.unsuspendUser(userId);
  await recordAudit({
    actorId: requireUserId(request),
    action: "user.unsuspend",
    entityType: "User",
    entityId: userId,
    metadata: { role: user.role },
  });
  response.status(200).json({ user });
}

export async function deleteUser(request: Request, response: Response): Promise<void> {
  const userId = requireIdParam(request);
  const reason =
    typeof request.query.reason === "string" && request.query.reason.trim().length > 0
      ? request.query.reason.trim()
      : typeof request.body?.reason === "string" && request.body.reason.trim().length > 0
        ? request.body.reason.trim()
        : undefined;
  const result = await adminListingsService.deleteUser(userId, reason);
  await recordAudit({
    actorId: requireUserId(request),
    action: "user.delete",
    entityType: "User",
    entityId: userId,
    metadata: { reason: reason ?? null, role: result.role },
  });
  response.status(200).json({ message: "User account data has been anonymized.", user: result });
}

export async function listVendors(request: Request, response: Response): Promise<void> {
  response.status(200).json(await adminListingsService.listVendors(q(request)));
}

export async function getVendor(request: Request, response: Response): Promise<void> {
  const vendorId = requireIdParam(request);
  const vendor = await adminListingsService.getVendor(vendorId);
  response.status(200).json({ vendor });
}

export async function listProducts(request: Request, response: Response): Promise<void> {
  response.status(200).json(await adminListingsService.listProducts(q(request)));
}

export async function listOrders(request: Request, response: Response): Promise<void> {
  response.status(200).json(await adminListingsService.listOrders(q(request)));
}

export async function getOrder(request: Request, response: Response): Promise<void> {
  const orderId = requireIdParam(request);
  const order = await adminListingsService.getOrder(orderId);
  response.status(200).json({ order });
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
