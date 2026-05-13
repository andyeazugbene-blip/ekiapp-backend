import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { addressesService } from "./addresses.service";
import { validateCreateAddressInput, validateUpdateAddressInput } from "./addresses.validation";

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

export async function listAddresses(request: Request, response: Response): Promise<void> {
  const addresses = await addressesService.list(requireUserId(request));
  response.status(200).json({ addresses });
}

export async function createAddress(request: Request, response: Response): Promise<void> {
  const input = validateCreateAddressInput(request.body);
  const address = await addressesService.create(requireUserId(request), input);
  response.status(201).json({ address });
}

export async function updateAddress(request: Request, response: Response): Promise<void> {
  const input = validateUpdateAddressInput(request.body);
  const address = await addressesService.update(requireUserId(request), requireIdParam(request), input);
  response.status(200).json({ address });
}

export async function deleteAddress(request: Request, response: Response): Promise<void> {
  await addressesService.delete(requireUserId(request), requireIdParam(request));
  response.status(200).json({ success: true });
}
