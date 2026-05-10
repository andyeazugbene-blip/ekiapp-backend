import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { paymentsService } from "./payments.service";

export async function createPaymentIntent(request: Request, response: Response): Promise<void> {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  const result = await paymentsService.createPaymentIntent(request.body, request.user.id);

  response.status(201).json(result);
}
