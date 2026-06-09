import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { productsService } from "./products.service";
import {
  validateCreateProductInput,
  validateListProductsQuery,
  validateUpdateProductInput,
} from "./products.validation";

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

function stripInternalCost<T extends Record<string, unknown>>(product: T): Omit<T, "costAmount" | "costCurrency"> {
  const { costAmount: _costAmount, costCurrency: _costCurrency, ...publicProduct } = product;
  return publicProduct;
}

export async function createProduct(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const input = validateCreateProductInput(request.body);
  const product = await productsService.createProduct(userId, input);
  response.status(201).json({ product });
}

export async function updateProduct(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const input = validateUpdateProductInput(request.body);
  const product = await productsService.updateProduct(userId, requireIdParam(request), input);
  response.status(200).json({ product });
}

export async function disableProduct(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const product = await productsService.disableProduct(userId, requireIdParam(request));
  response.status(200).json({ product });
}

export async function listProducts(request: Request, response: Response): Promise<void> {
  const query = validateListProductsQuery(request.query as Record<string, unknown>);
  const result = await productsService.listActiveProducts(query);
  response.status(200).json({
    ...result,
    items: result.items.map((product) => stripInternalCost(product as unknown as Record<string, unknown>)),
  });
}

export async function listMyProducts(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const items = await productsService.listMyProducts(userId);
  response.status(200).json({ items, nextCursor: null });
}

export async function getMyProduct(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const product = await productsService.getMyProductById(userId, requireIdParam(request));
  response.status(200).json({ product });
}

export async function getProduct(request: Request, response: Response): Promise<void> {
  const product = await productsService.getProductById(requireIdParam(request));
  response.status(200).json({ product: stripInternalCost(product as unknown as Record<string, unknown>) });
}
