import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { cartService } from "./cart.service";
import {
  validateAddCartItemInput,
  validateUpdateCartItemInput,
} from "./cart.validation";

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

export async function getCart(request: Request, response: Response): Promise<void> {
  const cart = await cartService.getCart(requireUserId(request));
  response.status(200).json({ cart });
}

export async function addCartItem(request: Request, response: Response): Promise<void> {
  const input = validateAddCartItemInput(request.body);
  const cart = await cartService.addItem(requireUserId(request), input);
  response.status(201).json({ cart });
}

export async function updateCartItem(request: Request, response: Response): Promise<void> {
  const input = validateUpdateCartItemInput(request.body);
  const cart = await cartService.updateItem(requireUserId(request), requireIdParam(request), input);
  response.status(200).json({ cart });
}

export async function removeCartItem(request: Request, response: Response): Promise<void> {
  const cart = await cartService.removeItem(requireUserId(request), requireIdParam(request));
  response.status(200).json({ cart });
}

export async function clearCart(request: Request, response: Response): Promise<void> {
  const cart = await cartService.clearCart(requireUserId(request));
  response.status(200).json({ cart });
}
