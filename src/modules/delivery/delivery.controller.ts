import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { deliveryService } from "./delivery.service";
import { validateCalculateDeliveryInput } from "./delivery.validation";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

export async function calculateDelivery(request: Request, response: Response): Promise<void> {
  const input = validateCalculateDeliveryInput(request.body);
  const result = await deliveryService.calculate(requireUserId(request), input);
  response.status(200).json(result);
}
