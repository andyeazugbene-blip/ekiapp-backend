import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { flashSalesService } from "./flash-sales.service";

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) throw new AppError("Invalid id", 400);
  return id;
}

export async function createFlashSale(request: Request, response: Response): Promise<void> {
  const body = request.body ?? {};
  if (typeof body.productId !== "string" || !body.productId) throw new AppError("productId is required", 400);
  const salePriceMinor = Number(body.salePriceMinor);
  if (!Number.isInteger(salePriceMinor)) throw new AppError("salePriceMinor must be an integer", 400);
  if (typeof body.startsAt !== "string" || typeof body.endsAt !== "string") {
    throw new AppError("startsAt and endsAt are required", 400);
  }
  const currency = typeof body.currency === "string" ? body.currency : "";

  const flashSale = await flashSalesService.create(requireUserId(request), {
    productId: body.productId,
    salePriceMinor,
    currency,
    startsAt: body.startsAt,
    endsAt: body.endsAt,
  });
  response.status(201).json({ flashSale });
}

export async function listMyFlashSales(request: Request, response: Response): Promise<void> {
  response.json({ items: await flashSalesService.listMine(requireUserId(request)) });
}

export async function updateFlashSaleActive(request: Request, response: Response): Promise<void> {
  const isActive = request.body?.isActive;
  if (typeof isActive !== "boolean") throw new AppError("isActive (boolean) is required", 400);
  response.json({ flashSale: await flashSalesService.setActive(requireUserId(request), requireIdParam(request), isActive) });
}

export async function deleteFlashSale(request: Request, response: Response): Promise<void> {
  await flashSalesService.remove(requireUserId(request), requireIdParam(request));
  response.status(204).send();
}

export async function listPublicFlashSales(_request: Request, response: Response): Promise<void> {
  response.json({ items: await flashSalesService.listPublic() });
}
