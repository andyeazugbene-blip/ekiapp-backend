import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { deliveryProofService } from "./delivery-proof.service";

function ids(request: Request): { userId: string; orderId: string } {
  if (!request.user) throw new AppError("Unauthorized", 401);
  const orderId = String(request.params.id ?? "");
  if (!orderId) throw new AppError("Order ID required", 400);
  return { userId: request.user.id, orderId };
}

export async function vendorAddDeliveryProof(request: Request, response: Response): Promise<void> {
  const { userId, orderId } = ids(request);
  const evidence = await deliveryProofService.addAsVendor(userId, orderId, (request.body ?? {}) as Record<string, unknown>);
  response.status(201).json({ evidence });
}
export async function vendorListDeliveryProof(request: Request, response: Response): Promise<void> {
  const { userId, orderId } = ids(request);
  response.status(200).json({ items: await deliveryProofService.listForVendor(userId, orderId) });
}
export async function buyerListDeliveryProof(request: Request, response: Response): Promise<void> {
  const { userId, orderId } = ids(request);
  response.status(200).json({ items: await deliveryProofService.listForBuyer(userId, orderId) });
}
