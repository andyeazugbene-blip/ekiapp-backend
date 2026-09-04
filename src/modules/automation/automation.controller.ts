import type { Request, Response } from "express";
import type { AutomationType } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { automationService, CONFIGURABLE_TYPES, DEFAULT_CONFIG } from "./automation.service";
import { VENDOR_TOGGLEABLE_AUTOMATION_TYPES } from "./automation.types";

// The three CAMPAIGN_* types are buyer-facing, campaign-lifecycle-triggered
// notifications with no vendor on/off concept — a vendor can only toggle
// the types listVendorAutomations() actually shows them.
const VALID_TYPES: AutomationType[] = VENDOR_TOGGLEABLE_AUTOMATION_TYPES;

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

  let config: Record<string, number> | undefined;
  if (CONFIGURABLE_TYPES.has(type) && request.body?.config) {
    const defaults = DEFAULT_CONFIG[type];
    config = {};
    for (const key of Object.keys(defaults)) {
      const value = request.body.config[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
        throw new AppError(`config.${key} must be a number >= 1`, 400);
      }
      config[key] = value;
    }
  }

  const setting = config
    ? await automationService.setVendorAutomation(vendorId, type, enabled, config)
    : await automationService.setVendorAutomation(vendorId, type, enabled);
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
