import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { adminOrdersService } from "./admin-orders.service";

function requireAdminId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

export async function processStuckOrder(request: Request, response: Response): Promise<void> {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) throw new AppError("Invalid id", 400);
  const reason = typeof request.body?.reason === "string" ? request.body.reason.trim() : "";
  if (reason.length < 10) throw new AppError("A reason of at least 10 characters is required", 400);
  const result = await adminOrdersService.processStuckOrder(id, requireAdminId(request), request, reason);
  response.status(200).json(result);
}

export async function completeOrder(request: Request, response: Response): Promise<void> {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new AppError("Invalid id", 400);
  }
  const result = await adminOrdersService.completeOrder(id, requireAdminId(request), request);
  response.status(200).json(result);
}
