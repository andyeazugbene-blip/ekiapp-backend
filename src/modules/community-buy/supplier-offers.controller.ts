import { createHash, randomInt } from "node:crypto";

import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { sendSms } from "../../lib/sms";
import { AppError } from "../../shared/errors/app-error";
import { organiserChecksMissing, supplierOffersService } from "./supplier-offers.service";
import { reviewRequestsService } from "./review-requests.service";
import { communityCampaignsService } from "./community-campaigns.service";

const PHONE_CODE_TTL_MS = 10 * 60_000;
const PHONE_CODE_MAX_ATTEMPTS = 5;
const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

function requireUserId(request: Request): string {
  const id = request.user?.id;
  if (!id) throw new AppError("Authentication required", 401);
  return id;
}

function idParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || !id) throw new AppError("Invalid id", 400);
  return id;
}

function hashCode(userId: string, code: string): string {
  return createHash("sha256").update(`${userId}:${code}`).digest("hex");
}

// ─── Supplier ─────────────────────────────────────────────────────────────

export async function listMySupplierOffers(request: Request, response: Response): Promise<void> {
  response.json({ items: await supplierOffersService.listMine(requireUserId(request)) });
}

export async function getMySupplierOffer(request: Request, response: Response): Promise<void> {
  response.json({ offer: await supplierOffersService.getMine(requireUserId(request), idParam(request)) });
}

export async function createSupplierOffer(request: Request, response: Response): Promise<void> {
  response.status(201).json({ offer: await supplierOffersService.createDraft(requireUserId(request), request.body ?? {}) });
}

export async function updateSupplierOffer(request: Request, response: Response): Promise<void> {
  response.json({ offer: await supplierOffersService.update(requireUserId(request), idParam(request), request.body ?? {}) });
}

export async function submitSupplierOffer(request: Request, response: Response): Promise<void> {
  response.json(await supplierOffersService.submit(requireUserId(request), idParam(request)));
}

export async function withdrawSupplierOffer(request: Request, response: Response): Promise<void> {
  response.json({ offer: await supplierOffersService.withdraw(requireUserId(request), idParam(request)) });
}

export async function reconfirmOfferExtension(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const canSupply = (request.body as { canSupply?: unknown } | undefined)?.canSupply === true;
  const extension = await communityCampaignsService.reconfirmExtensionAsSupplier(userId, String(request.params.id), canSupply);
  if (!canSupply) await reviewRequestsService.closeExtension(extension.campaignId, "REJECTED", undefined, "The supplier can't keep this offer open longer.");
  response.json({ extensionRequest: extension });
}

export async function listSupplierOfferOrders(request: Request, response: Response): Promise<void> {
  response.json({ items: await supplierOffersService.listSupplierOrders(requireUserId(request)) });
}

// ─── Organiser ────────────────────────────────────────────────────────────

export async function listOffersForOrganiser(request: Request, response: Response): Promise<void> {
  response.json({ items: await supplierOffersService.listForOrganisers(requireUserId(request)) });
}

export async function createDemandRequest(request: Request, response: Response): Promise<void> {
  const { foodstuff, area } = request.body ?? {};
  response.status(201).json({ request: await supplierOffersService.requestFoodstuff(requireUserId(request), foodstuff, area) });
}

export async function createOfferCampaign(request: Request, response: Response): Promise<void> {
  response.status(201).json({ campaign: await supplierOffersService.createCampaignDraft(requireUserId(request), request.body ?? {}) });
}

export async function updateOfferCampaign(request: Request, response: Response): Promise<void> {
  response.json({ campaign: await supplierOffersService.updateCampaignDraft(requireUserId(request), idParam(request), request.body ?? {}) });
}

export async function submitOfferCampaign(request: Request, response: Response): Promise<void> {
  response.json(await supplierOffersService.submitCampaign(requireUserId(request), idParam(request)));
}

export async function withdrawOfferCampaign(request: Request, response: Response): Promise<void> {
  response.json({ campaign: await supplierOffersService.withdrawCampaign(requireUserId(request), idParam(request)) });
}

export async function registerCampaignInterest(request: Request, response: Response): Promise<void> {
  response.json(await supplierOffersService.registerInterest(requireUserId(request), idParam(request)));
}

export async function getOrganiserChecks(request: Request, response: Response): Promise<void> {
  response.json({ missing: await organiserChecksMissing(requireUserId(request)) });
}

export async function sendPhoneCode(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const phone = typeof request.body?.phone === "string" ? request.body.phone.replace(/[\s()-]/g, "") : "";
  if (!PHONE_PATTERN.test(phone)) {
    throw new AppError("Enter your phone number with its country code, for example +447700900000.", 400, undefined, "PHONE_INVALID");
  }
  const taken = await prisma.user.findFirst({ where: { phone, id: { not: userId } }, select: { id: true } });
  if (taken) throw new AppError("That phone number is already on another account.", 409, undefined, "PHONE_IN_USE");

  const code = String(randomInt(100000, 1000000));
  const data = { phone, codeHash: hashCode(userId, code), attempts: 0, expiresAt: new Date(Date.now() + PHONE_CODE_TTL_MS) };
  await prisma.phoneVerification.upsert({ where: { userId }, create: { userId, ...data }, update: data });

  const sent = await sendSms({ to: phone, message: `Your Eki code is ${code}. It expires in 10 minutes.`, purpose: "phone_verification" });
  if (!sent) throw new AppError("We couldn't send a code right now. Please try again.", 503, undefined, "PHONE_CODE_NOT_SENT");
  response.json({ sent: true });
}

export async function confirmPhoneCode(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const code = typeof request.body?.code === "string" ? request.body.code.trim() : "";
  const pending = await prisma.phoneVerification.findUnique({ where: { userId } });
  if (!pending || pending.expiresAt < new Date() || pending.attempts >= PHONE_CODE_MAX_ATTEMPTS) {
    throw new AppError("That code has expired. Please ask for a new one.", 400, undefined, "PHONE_CODE_EXPIRED");
  }
  if (pending.codeHash !== hashCode(userId, code)) {
    await prisma.phoneVerification.update({ where: { userId }, data: { attempts: { increment: 1 } } });
    throw new AppError("That code isn't right. Please check it and try again.", 400, undefined, "PHONE_CODE_WRONG");
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { phone: pending.phone, phoneVerifiedAt: new Date() } }),
    prisma.phoneVerification.delete({ where: { userId } }),
  ]);
  response.json({ verified: true, missing: await organiserChecksMissing(userId) });
}

// ─── Admin: Approvals queue ───────────────────────────────────────────────

export async function adminListReviewRequests(request: Request, response: Response): Promise<void> {
  const q = request.query;
  const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  response.json({
    items: await reviewRequestsService.listQueue({
      type: text(q.type),
      market: text(q.market),
      status: text(q.status),
      overdueOnly: q.overdue === "true",
    }),
  });
}

export async function adminGetReviewRequest(request: Request, response: Response): Promise<void> {
  response.json(await reviewRequestsService.getDetail(idParam(request)));
}

export async function adminApproveReviewRequest(request: Request, response: Response): Promise<void> {
  response.json({ request: await reviewRequestsService.approve(idParam(request), requireUserId(request)) });
}

export async function adminRequestReviewInformation(request: Request, response: Response): Promise<void> {
  response.json({ request: await reviewRequestsService.requestInformation(idParam(request), requireUserId(request), request.body?.message) });
}

export async function adminRejectReviewRequest(request: Request, response: Response): Promise<void> {
  const { reasonCode, detail } = request.body ?? {};
  response.json({ request: await reviewRequestsService.reject(idParam(request), requireUserId(request), reasonCode, detail) });
}

export async function adminListDemandRequests(_request: Request, response: Response): Promise<void> {
  response.json({ items: await supplierOffersService.listDemandForAdmin() });
}
