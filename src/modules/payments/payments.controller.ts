import type { Request, Response } from "express";

import { paymentsService } from "./payments.service";

export async function createPaymentIntent(request: Request, response: Response): Promise<void> {
  const result = await paymentsService.createPaymentIntent(request.body);

  response.status(201).json(result);
}
