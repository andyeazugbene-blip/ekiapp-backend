import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { shipmentsService } from "./shipments.service";
import {
  validateCreateShipmentInput,
  validateListShipmentsQuery,
  validateUpdateShipmentInput,
} from "./shipments.validation";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

function requireIdParam(request: Request, param = "id"): string {
  const id = request.params[param];
  if (typeof id !== "string" || id.length === 0) {
    throw new AppError(`Invalid ${param}`, 400);
  }
  return id;
}

export async function createShipment(request: Request, response: Response): Promise<void> {
  const input = validateCreateShipmentInput(request.body);
  const orderId = requireIdParam(request, "orderId");
  const shipment = await shipmentsService.createShipment(requireUserId(request), orderId, input);
  response.status(201).json({ shipment });
}

export async function updateShipment(request: Request, response: Response): Promise<void> {
  const input = validateUpdateShipmentInput(request.body);
  const shipment = await shipmentsService.updateShipment(
    requireUserId(request),
    requireIdParam(request),
    input,
  );
  response.status(200).json({ shipment });
}

export async function listVendorShipments(request: Request, response: Response): Promise<void> {
  const query = validateListShipmentsQuery(request.query as Record<string, unknown>);
  const result = await shipmentsService.listVendorShipments(requireUserId(request), query);
  response.status(200).json(result);
}

export async function getShipmentByOrder(request: Request, response: Response): Promise<void> {
  const orderId = requireIdParam(request, "orderId");
  const shipment = await shipmentsService.getShipmentByOrder(requireUserId(request), orderId);
  response.status(200).json({ shipment });
}
