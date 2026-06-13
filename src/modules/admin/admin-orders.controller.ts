import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { adminOrdersService } from "./admin-orders.service";

export async function processStuckOrder(request: Request, response: Response): Promise<void> {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) throw new AppError("Invalid id", 400);
  const result = await adminOrdersService.processStuckOrder(id);
  response.status(200).json(result);
}

export async function completeOrder(request: Request, response: Response): Promise<void> {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new AppError("Invalid id", 400);
  }
  const result = await adminOrdersService.completeOrder(id);
  response.status(200).json(result);
}
