import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit, requireAuditReason } from "../../shared/utils/audit";
import { adminProductsService } from "./admin-products.service";

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) throw new AppError("Invalid id", 400);
  return id;
}

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

function reasonFrom(request: Request): string {
  // Body preferred; query accepted for clients that cannot send a PATCH body.
  return requireAuditReason(request.body?.reason ?? request.query.reason);
}

export async function adminListProducts(request: Request, response: Response): Promise<void> {
  response.status(200).json(await adminProductsService.listProducts(request.query as Record<string, unknown>));
}

export async function adminGetProduct(request: Request, response: Response): Promise<void> {
  response.status(200).json({ product: await adminProductsService.getProduct(requireIdParam(request)) });
}

export async function adminUnpublishProduct(request: Request, response: Response): Promise<void> {
  const reason = reasonFrom(request);
  const actorId = requireUserId(request);
  const productId = requireIdParam(request);
  const { product, before, after } = await adminProductsService.unpublish(productId, reason, actorId);
  await recordAudit({
    request,
    actorId,
    action: "product.unpublish",
    entityType: "Product",
    entityId: productId,
    reason,
    beforeState: before,
    afterState: after,
    metadata: { vendorId: product.vendorId, title: product.title },
  });
  if (product.vendor?.userId) {
    await adminProductsService.notifyVendor({
      vendorUserId: product.vendor.userId,
      productId,
      productTitle: product.title,
      action: "unpublished",
      reason,
    });
  }
  response.status(200).json({ product: await adminProductsService.getProduct(productId) });
}

export async function adminRestoreProduct(request: Request, response: Response): Promise<void> {
  const reason = reasonFrom(request);
  const actorId = requireUserId(request);
  const productId = requireIdParam(request);
  const { product, before, after } = await adminProductsService.restore(productId, reason);
  await recordAudit({
    request,
    actorId,
    action: "product.restore",
    entityType: "Product",
    entityId: productId,
    reason,
    beforeState: before,
    afterState: after,
    metadata: { vendorId: product.vendorId, title: product.title },
  });
  if (product.vendor?.userId) {
    await adminProductsService.notifyVendor({
      vendorUserId: product.vendor.userId,
      productId,
      productTitle: product.title,
      action: "restored",
      reason,
    });
  }
  response.status(200).json({ product: await adminProductsService.getProduct(productId) });
}
