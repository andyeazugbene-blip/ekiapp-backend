import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import type { PublicStoreEventType, TrackPublicStoreEventInput } from "./public-stores.types";
import { publicStoresService } from "./public-stores.service";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const VALID_EVENTS = new Set<PublicStoreEventType>([
  "open",
  "add_to_cart",
  "start_checkout",
  "place_order",
  "track_order",
  "reorder",
  "open_in_app",
  "save_vendor",
]);

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

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

function parseTrackEventInput(body: unknown): TrackPublicStoreEventInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("Invalid request body", 400);
  }

  const raw = body as Record<string, unknown>;
  if (typeof raw.event !== "string" || !VALID_EVENTS.has(raw.event as PublicStoreEventType)) {
    throw new AppError("Invalid event", 400);
  }

  return {
    event: raw.event as PublicStoreEventType,
    source: typeof raw.source === "string" ? raw.source : undefined,
    productId: typeof raw.productId === "string" ? raw.productId : undefined,
    productName: typeof raw.productName === "string" ? raw.productName : undefined,
    quantity: typeof raw.quantity === "number" ? raw.quantity : raw.quantity != null ? Number(raw.quantity) : undefined,
    orderTotal: typeof raw.orderTotal === "number" ? raw.orderTotal : raw.orderTotal != null ? Number(raw.orderTotal) : undefined,
    orderIds: Array.isArray(raw.orderIds) ? raw.orderIds.filter((value): value is string => typeof value === "string") : undefined,
    items: Array.isArray(raw.items) ? (raw.items as TrackPublicStoreEventInput["items"]) : undefined,
  };
}

function parseLookupEmail(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("Invalid request body", 400);
  }

  const raw = body as Record<string, unknown>;
  if (typeof raw.email !== "string" || !raw.email.trim() || !raw.email.includes("@")) {
    throw new AppError("Valid email address required", 400);
  }

  return raw.email.trim().toLowerCase();
}

function parseLookupVerification(body: unknown): { email: string; code: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("Invalid request body", 400);
  }

  const raw = body as Record<string, unknown>;
  if (typeof raw.email !== "string" || !raw.email.trim() || !raw.email.includes("@")) {
    throw new AppError("Valid email address required", 400);
  }
  if (typeof raw.code !== "string" || !/^\d{6}$/.test(raw.code.trim())) {
    throw new AppError("Code must be a 6-digit number", 400);
  }

  return {
    email: raw.email.trim().toLowerCase(),
    code: raw.code.trim(),
  };
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

export async function trackPublicStoreEvent(request: Request, response: Response): Promise<void> {
  const slug = parseSlug(request);
  const input = parseTrackEventInput(request.body);
  const analytics = await publicStoresService.recordEvent(slug, input, request.user?.id);
  response.status(200).json({ analytics });
}

export async function getVendorPublicStoreAnalytics(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const requestedStoreSlug = typeof request.query.storeSlug === "string" ? request.query.storeSlug.trim().toLowerCase() : undefined;
  const analytics = await publicStoresService.getDetailedAnalyticsForUser(userId, requestedStoreSlug);
  response.status(200).json({ analytics });
}

export async function requestPublicStoreOrderLookup(request: Request, response: Response): Promise<void> {
  const slug = parseSlug(request);
  const email = parseLookupEmail(request.body);

  try {
    await publicStoresService.requestGuestOrderLookupCode(slug, email);
  } catch {
    // Always return success to avoid order/email enumeration.
  }

  response.status(200).json({ message: "If matching orders exist, a verification code has been sent." });
}

export async function verifyPublicStoreOrderLookup(request: Request, response: Response): Promise<void> {
  const slug = parseSlug(request);
  const { email, code } = parseLookupVerification(request.body);
  const orders = await publicStoresService.verifyGuestOrderLookup(slug, email, code);
  response.status(200).json({ orders });
}
