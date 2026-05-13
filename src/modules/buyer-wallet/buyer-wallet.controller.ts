import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { buyerWalletService } from "./buyer-wallet.service";
import {
  validateApplyWalletInput,
  validateListWalletTransactionsQuery,
  validateTopUpInput,
} from "./buyer-wallet.validation";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

export async function getWallet(request: Request, response: Response): Promise<void> {
  const wallet = await buyerWalletService.getWallet(requireUserId(request));
  response.status(200).json({ wallet });
}

export async function listTransactions(request: Request, response: Response): Promise<void> {
  const query = validateListWalletTransactionsQuery(request.query as Record<string, unknown>);
  const result = await buyerWalletService.listTransactions(requireUserId(request), query);
  response.status(200).json(result);
}

export async function topUp(request: Request, response: Response): Promise<void> {
  const input = validateTopUpInput(request.body);
  const transaction = await buyerWalletService.topUp(requireUserId(request), input);
  response.status(201).json({ transaction });
}

export async function applyToOrder(request: Request, response: Response): Promise<void> {
  const input = validateApplyWalletInput(request.body);
  const transaction = await buyerWalletService.applyToOrder(requireUserId(request), input);
  response.status(200).json({ transaction });
}
