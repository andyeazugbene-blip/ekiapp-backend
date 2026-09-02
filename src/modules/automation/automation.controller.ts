import type { Request, Response } from "express";
import type { AutomationType } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { automationService } from "./automation.service";

const VALID_TYPES: AutomationType[] = [
  "FIRST_SALE", "CART_RECOVERY", "BUYER_WIN_BACK", "REVIEW_REQUEST", "LOW_STOCK_ALERT",
  "BUYER_REFERRAL", "PAYMENT_RECOVERY", "RENEWAL_REMINDER", "PRICE_APPROVAL_REMINDER",
  "CAMPAIGN_MILESTONE", "CAMPAIGN_DEADLINE", "CAMPAIGN_REFUND_UPDATE",
];

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

async function requireVendorId(userId: string): Promise<string> {
  const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
  if (!vendor) throw new AppError("Vendor profile required", 403);
  return vendor.id;
}

export async function listVendorAutomations(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  response.json({ items: await automationService.listVendorAutomations(vendorId) });
}

export async function updateVendorAutomation(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  const type = request.params.id as AutomationType;
  if (!VALID_TYPES.includes(type)) throw new AppError("Unknown automation type", 400);
  const enabled = request.body?.enabled;
  if (typeof enabled !== "boolean") throw new AppError("enabled must be a boolean", 400);
  const setting = await automationService.setVendorAutomation(vendorId, type, enabled);
  response.json({ setting });
}

export async function listVendorAutomationActivity(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  const limit = request.query.limit ? Number(request.query.limit) : 50;
  response.json({ items: await automationService.listVendorActivity(vendorId, limit) });
}

export async function getAdminAutomationSummary(_request: Request, response: Response): Promise<void> {
  response.json(await automationService.adminSummary());
}
