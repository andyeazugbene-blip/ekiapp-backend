import type { NextFunction, Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { requireAuditReason } from "../../shared/utils/audit";
import { maskEmail, maskPhone } from "../../shared/utils/mask";

/**
 * Handbook 13: sensitive data is masked in the admin panel. Contact details
 * reach an admin only through a reveal, which needs a reason and is audited.
 */
const EMAIL_KEY = /^email$|[a-z]Email$/;
const PHONE_KEY = /^phone$|[a-z]Phone$/;
const MAX_DEPTH = 12;

/** Admins manage each other, and settings hold system addresses, not personal data. */
const UNMASKED_GET_PATHS = ["/admins", "/me", "/settings"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function maskContactDeep<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => maskContactDeep(item, depth + 1)) as unknown as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && EMAIL_KEY.test(key)) out[key] = maskEmail(item);
    else if (typeof item === "string" && PHONE_KEY.test(key)) out[key] = maskPhone(item);
    else out[key] = maskContactDeep(item, depth + 1);
  }
  return out as T;
}

function containsMaskedContact(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || !isPlainObject(value)) return false;
  return Object.entries(value).some(([key, item]) => {
    if (typeof item === "string") return (EMAIL_KEY.test(key) || PHONE_KEY.test(key)) && item.includes("•");
    return containsMaskedContact(item, depth + 1);
  });
}

/**
 * Masks every admin read, including nested records and new endpoints, and
 * refuses a write that would save a masked value over the real one.
 */
export function adminContactPrivacy(request: Request, response: Response, next: NextFunction): void {
  if (request.method !== "GET") {
    if (containsMaskedContact(request.body)) {
      next(new AppError("Reveal the contact details before changing them.", 400, undefined, "MASKED_VALUE_SUBMITTED"));
      return;
    }
    next();
    return;
  }
  if (UNMASKED_GET_PATHS.some((path) => request.path === path || request.path.startsWith(`${path}/`))) {
    next();
    return;
  }
  const json = response.json.bind(response);
  response.json = (body: unknown) => json(maskContactDeep(body));
  next();
}

type Kind = "user" | "vendor" | "supplier";

async function loadContact(kind: Kind, id: string): Promise<{ email: string | null; phone: string | null } | null> {
  if (kind === "user") {
    const user = await prisma.user.findUnique({ where: { id }, select: { email: true, phone: true, anonymisedAt: true } });
    if (!user) return null;
    return user.anonymisedAt ? { email: null, phone: null } : { email: user.email, phone: user.phone };
  }
  if (kind === "vendor") {
    const vendor = await prisma.vendor.findUnique({ where: { id }, select: { contactEmail: true, contactPhone: true, user: { select: { email: true, phone: true } } } });
    if (!vendor) return null;
    return { email: vendor.contactEmail ?? vendor.user?.email ?? null, phone: vendor.contactPhone ?? vendor.user?.phone ?? null };
  }
  const supplier = await prisma.supplierAccount.findUnique({ where: { id }, select: { user: { select: { email: true, phone: true } } } });
  if (!supplier) return null;
  return { email: supplier.user?.email ?? null, phone: supplier.user?.phone ?? null };
}

function revealHandler(kind: Kind) {
  return async (request: Request, response: Response): Promise<void> => {
    if (!request.user) throw new AppError("Unauthorized", 401);
    const id = request.params.id;
    if (typeof id !== "string" || !id) throw new AppError("Invalid id", 400);
    const reason = requireAuditReason((request.body as { reason?: unknown } | undefined)?.reason);
    const contact = await loadContact(kind, id);
    if (!contact) throw new AppError("Record not found", 404);
    // Written directly and awaited: if the audit can't be recorded, nothing is revealed.
    await prisma.auditLog.create({
      data: {
        actorId: request.user.id,
        action: "pii.reveal",
        entityType: kind,
        entityId: id,
        reason,
        permissionUsed: request.usedPermission ?? null,
        ipAddress: request.ip ?? null,
      },
    });
    response.status(200).json({ contact });
  };
}

export const revealUserContact = revealHandler("user");
export const revealVendorContact = revealHandler("vendor");
export const revealSupplierContact = revealHandler("supplier");
