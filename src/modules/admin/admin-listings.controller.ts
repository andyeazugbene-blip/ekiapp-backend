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
    action: result.hardDeleted ? "user.hard_delete" : "user.delete",
    entityType: "User",
    entityId: userId,
    metadata: { reason: reason ?? null, role: result.role, hardDeleted: result.hardDeleted },
  });
  response.status(200).json({
    message: result.hardDeleted
      ? "User account and all related data have been permanently deleted."
      : "User has order/payment/review history and cannot be fully erased; account data has been anonymized instead.",
    user: result,
  });
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

export async function getProduct(request: Request, response: Response): Promise<void> {
  const product = await adminListingsService.getProduct(requireIdParam(request));
  response.status(200).json({ product });
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
  const vendor = await adminListingsService.approveVendor(vendorId, requireUserId(request));
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
  const reason =
    typeof request.body?.rejectionReason === "string"
      ? request.body.rejectionReason.trim()
      : typeof request.body?.reason === "string"
        ? request.body.reason.trim()
        : undefined;
  const vendor = await adminListingsService.rejectVendor(vendorId, requireUserId(request), reason);
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

export async function getPayment(request: Request, response: Response): Promise<void> {
  const payment = await adminListingsService.getPayment(requireIdParam(request));
  response.status(200).json({ payment });
}

export async function getWalletTransaction(request: Request, response: Response): Promise<void> {
  const transaction = await adminListingsService.getWalletTransaction(requireIdParam(request));
  response.status(200).json({ transaction });
}

export async function updateVendor(request: Request, response: Response): Promise<void> {
  const vendorId = requireIdParam(request);
  const vendor = await adminListingsService.updateVendor(vendorId, request.body ?? {});
  await recordAudit({
    actorId: requireUserId(request),
    action: "vendor.update",
    entityType: "Vendor",
    entityId: vendorId,
  });
  response.status(200).json({ vendor });
}

export async function deleteVendor(request: Request, response: Response): Promise<void> {
  const vendorId = requireIdParam(request);
  const reason = typeof request.body?.reason === "string" && request.body.reason.trim().length > 0
    ? request.body.reason.trim()
    : undefined;
  const result = await adminListingsService.deleteVendor(vendorId, reason);
  await recordAudit({
    actorId: requireUserId(request),
    action: result.hardDeleted ? "vendor.hard_delete" : "vendor.delete",
    entityType: "Vendor",
    entityId: vendorId,
    metadata: { hardDeleted: result.hardDeleted },
  });
  response.status(200).json({
    ...result,
    message: result.hardDeleted
      ? "Vendor account and all related data have been permanently deleted."
      : "Vendor has order/payout history and cannot be fully erased; account has been anonymized and suspended instead.",
  });
}

export async function getVendorStats(_request: Request, response: Response): Promise<void> {
  const stats = await adminListingsService.getVendorStats();
  response.status(200).json(stats);
}

export async function bulkApproveVendors(request: Request, response: Response): Promise<void> {
  const ids = request.body?.vendorIds;
  if (!Array.isArray(ids) || ids.length === 0) throw new AppError("vendorIds array required", 400);
  const result = await adminListingsService.bulkApproveVendors(ids, requireUserId(request));
  await recordAudit({
    actorId: requireUserId(request),
    action: "vendor.bulk_approve",
    entityType: "Vendor",
    metadata: { count: result.affected },
  });
  response.status(200).json(result);
}

export async function bulkRejectVendors(request: Request, response: Response): Promise<void> {
  const ids = request.body?.vendorIds;
  if (!Array.isArray(ids) || ids.length === 0) throw new AppError("vendorIds array required", 400);
  const reason = typeof request.body?.reason === "string" ? request.body.reason.trim() : undefined;
  const result = await adminListingsService.bulkRejectVendors(ids, requireUserId(request), reason);
  await recordAudit({
    actorId: requireUserId(request),
    action: "vendor.bulk_reject",
    entityType: "Vendor",
    metadata: { count: result.affected },
  });
  response.status(200).json(result);
}

export async function bulkSuspendVendors(request: Request, response: Response): Promise<void> {
  const ids = request.body?.vendorIds;
  if (!Array.isArray(ids) || ids.length === 0) throw new AppError("vendorIds array required", 400);
  const reason = typeof request.body?.reason === "string" ? request.body.reason.trim() : undefined;
  const result = await adminListingsService.bulkSuspendVendors(ids, reason);
  await recordAudit({
    actorId: requireUserId(request),
    action: "vendor.bulk_suspend",
    entityType: "Vendor",
    metadata: { count: result.affected },
  });
  response.status(200).json(result);
}
