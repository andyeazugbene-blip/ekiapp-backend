import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { ordersService } from "./orders.service";
import {
  validateListBuyerOrdersQuery,
  validateListVendorOrdersQuery,
  validateUpdateOrderStatusInput,
} from "./orders.validation";

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

// ─── Buyer Endpoints ─────────────────────────────────────────────────────────

export async function listBuyerOrders(request: Request, response: Response): Promise<void> {
  const query = validateListBuyerOrdersQuery(request.query as Record<string, unknown>);
  const result = await ordersService.listBuyerOrders(requireUserId(request), query);
  response.status(200).json(result);
}

export async function getBuyerOrder(request: Request, response: Response): Promise<void> {
  const order = await ordersService.getBuyerOrder(requireUserId(request), requireIdParam(request));
  response.status(200).json({ order });
}

// ─── Vendor Endpoints ────────────────────────────────────────────────────────

export async function listVendorOrders(request: Request, response: Response): Promise<void> {
  const query = validateListVendorOrdersQuery(request.query as Record<string, unknown>);
  const result = await ordersService.listVendorOrders(requireUserId(request), query);
  response.status(200).json(result);
}

export async function getVendorOrder(request: Request, response: Response): Promise<void> {
  const order = await ordersService.getVendorOrder(requireUserId(request), requireIdParam(request));
  response.status(200).json({ order });
}

export async function updateVendorOrderStatus(request: Request, response: Response): Promise<void> {
  const input = validateUpdateOrderStatusInput(request.body);
  const order = await ordersService.updateVendorOrderStatus(
    requireUserId(request),
    requireIdParam(request),
    input.status,
  );
  response.status(200).json({ order });
}

export async function completeBuyerOrder(request: Request, response: Response): Promise<void> {
  const order = await ordersService.completeBuyerOrder(requireUserId(request), requireIdParam(request));
  response.status(200).json({ order });
}
