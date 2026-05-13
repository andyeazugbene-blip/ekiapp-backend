import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { deliveryZonesService } from "./delivery-zones.service";
import {
  validateCreateDeliveryMethodInput,
  validateCreateDeliveryZoneInput,
  validateUpdateDeliveryMethodInput,
  validateUpdateDeliveryZoneInput,
} from "./delivery-zones.validation";

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

// ─── Public ──────────────────────────────────────────────────────────────────

export async function listActiveZones(_request: Request, response: Response): Promise<void> {
  const zones = await deliveryZonesService.listActiveZones();
  response.status(200).json({ zones });
}

// ─── Vendor ──────────────────────────────────────────────────────────────────

export async function listVendorZones(request: Request, response: Response): Promise<void> {
  const zones = await deliveryZonesService.listVendorZones(requireUserId(request));
  response.status(200).json({ zones });
}

export async function createVendorZone(request: Request, response: Response): Promise<void> {
  const input = validateCreateDeliveryZoneInput(request.body);
  const zone = await deliveryZonesService.createVendorZone(requireUserId(request), input);
  response.status(201).json({ zone });
}

export async function updateVendorZone(request: Request, response: Response): Promise<void> {
  const input = validateUpdateDeliveryZoneInput(request.body);
  const zone = await deliveryZonesService.updateVendorZone(
    requireUserId(request),
    requireIdParam(request),
    input,
  );
  response.status(200).json({ zone });
}

export async function deleteVendorZone(request: Request, response: Response): Promise<void> {
  await deliveryZonesService.deleteVendorZone(requireUserId(request), requireIdParam(request));
  response.status(200).json({ success: true });
}

// ─── Delivery Methods ────────────────────────────────────────────────────────

export async function addDeliveryMethod(request: Request, response: Response): Promise<void> {
  const input = validateCreateDeliveryMethodInput(request.body);
  const method = await deliveryZonesService.addMethod(
    requireUserId(request),
    requireIdParam(request, "zoneId"),
    input,
  );
  response.status(201).json({ method });
}

export async function updateDeliveryMethod(request: Request, response: Response): Promise<void> {
  const input = validateUpdateDeliveryMethodInput(request.body);
  const method = await deliveryZonesService.updateMethod(
    requireUserId(request),
    requireIdParam(request),
    input,
  );
  response.status(200).json({ method });
}

export async function deleteDeliveryMethod(request: Request, response: Response): Promise<void> {
  await deliveryZonesService.deleteMethod(requireUserId(request), requireIdParam(request));
  response.status(200).json({ success: true });
}
