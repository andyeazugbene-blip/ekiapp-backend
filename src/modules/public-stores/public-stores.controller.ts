import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { publicStoresService } from "./public-stores.service";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

function parseSlug(request: Request): string {
  const slug = String(request.params.slug ?? "").trim().toLowerCase();
  if (!slug || slug.length > 200 || !/^[a-z0-9-]+$/.test(slug)) {
    throw new AppError("Store not found", 404);
  }
  return slug;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export async function getPublicStore(request: Request, response: Response): Promise<void> {
  const slug = parseSlug(request);
  const store = await publicStoresService.getStoreBySlug(slug);
  response.status(200).json({ store });
}

export async function listPublicStoreProducts(
  request: Request,
  response: Response,
): Promise<void> {
  const slug = parseSlug(request);
  const limit = parseLimit(request.query.limit);
  const cursor = request.query.cursor ? String(request.query.cursor) : undefined;
  const category = request.query.category ? String(request.query.category) : undefined;

  const result = await publicStoresService.listStoreProducts(slug, { limit, cursor, category });
  response.status(200).json(result);
}
