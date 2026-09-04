import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { bundlesService } from "./bundles.service";

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) throw new AppError("Invalid id", 400);
  return id;
}

export async function createBundle(request: Request, response: Response): Promise<void> {
  const body = request.body ?? {};
  if (typeof body.name !== "string" || !body.name.trim()) throw new AppError("name is required", 400);
  if (!Array.isArray(body.productIds) || body.productIds.some((p: unknown) => typeof p !== "string")) {
    throw new AppError("productIds must be an array of strings", 400);
  }
  const bundlePriceMinor = Number(body.bundlePriceMinor);
  if (!Number.isInteger(bundlePriceMinor)) throw new AppError("bundlePriceMinor must be an integer", 400);
  const currency = typeof body.currency === "string" ? body.currency : "";

  const quantityAvailable = body.quantityAvailable == null ? null : Number(body.quantityAvailable);
  const bundle = await bundlesService.create(requireUserId(request), { name: body.name, productIds: body.productIds, bundlePriceMinor, currency, quantityAvailable });
  response.status(201).json({ bundle });
}

export async function listMyBundles(request: Request, response: Response): Promise<void> {
  response.json({ items: await bundlesService.listMine(requireUserId(request)) });
}

export async function updateBundleActive(request: Request, response: Response): Promise<void> {
  const isActive = request.body?.isActive;
  if (typeof isActive !== "boolean") throw new AppError("isActive (boolean) is required", 400);
  response.json({ bundle: await bundlesService.setActive(requireUserId(request), requireIdParam(request), isActive) });
}

export async function deleteBundle(request: Request, response: Response): Promise<void> {
  await bundlesService.remove(requireUserId(request), requireIdParam(request));
  response.status(204).send();
}

export async function listPublicBundles(_request: Request, response: Response): Promise<void> {
  response.json({ items: await bundlesService.listPublic() });
}
