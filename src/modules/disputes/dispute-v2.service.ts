import type { DisputeEvidenceKind, DisputeParty, DisputeType } from "@prisma/client";

import { logger } from "../../lib/logger";
import { eventsService, EVENT_NAMES } from "../events/events.service";
import { prisma } from "../../lib/prisma";
import { generatePresignedRead } from "../../lib/storage";
import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";

/** Handbook §11 L454: disputes carry type, claim, evidence, deadlines, communication, decision, appeal state. */

export const DISPUTE_TYPES = ["NOT_RECEIVED", "DAMAGED", "WRONG_ITEM", "QUALITY", "OTHER"] as const;
export const DEFAULT_RESPONSE_DAYS = 5;
export const APPEAL_WINDOW_DAYS = 7;
const DUE_SOON_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseDisputeType(value: unknown): DisputeType {
  if (value === undefined || value === null || value === "") return "OTHER";
  if (typeof value !== "string" || !(DISPUTE_TYPES as readonly string[]).includes(value.toUpperCase())) {
    throw new AppError(`type must be one of ${DISPUTE_TYPES.join(", ")}`, 400);
  }
  return value.toUpperCase() as DisputeType;
}

export function defaultRespondByAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + DEFAULT_RESPONSE_DAYS * DAY_MS);
}

export type DeadlineState = "NONE" | "ON_TIME" | "DUE_SOON" | "OVERDUE" | "CLOSED";

export function computeDeadlineState(
  dispute: { status: string; respondByAt: Date | null },
  now: Date = new Date(),
): { state: DeadlineState; respondByAt: Date | null; msRemaining: number | null } {
  if (dispute.status !== "OPEN") return { state: "CLOSED", respondByAt: dispute.respondByAt, msRemaining: null };
  if (!dispute.respondByAt) return { state: "NONE", respondByAt: null, msRemaining: null };
  const ms = dispute.respondByAt.getTime() - now.getTime();
  const state: DeadlineState = ms < 0 ? "OVERDUE" : ms <= DUE_SOON_MS ? "DUE_SOON" : "ON_TIME";
  return { state, respondByAt: dispute.respondByAt, msRemaining: ms };
}

export function appealState(dispute: {
  status: string;
  appealStatus: string;
  resolvedAt: Date | null;
}, now: Date = new Date()): { canAppeal: boolean; appealWindowEndsAt: Date | null } {
  if (dispute.status === "OPEN" || !dispute.resolvedAt) return { canAppeal: false, appealWindowEndsAt: null };
  const endsAt = new Date(dispute.resolvedAt.getTime() + APPEAL_WINDOW_DAYS * DAY_MS);
  return { canAppeal: dispute.appealStatus === "NONE" && now <= endsAt, appealWindowEndsAt: endsAt };
}

/** Which side lost the decision (and so may appeal). PARTIAL: either side may appeal. */
export function partiesAllowedToAppeal(status: string): DisputeParty[] {
  if (status === "RESOLVED_VENDOR") return ["BUYER"];
  if (status === "RESOLVED_BUYER") return ["VENDOR"];
  if (status === "RESOLVED_PARTIAL") return ["BUYER", "VENDOR"];
  return [];
}

type DisputeRow = {
  id: string; orderId: string; buyerId: string; vendorId: string; status: string;
  appealStatus: string; resolvedAt: Date | null; respondByAt: Date | null;
};

/** Party check — never reveals whether a dispute exists to a non-party (404, not 403). */
export async function requireDisputeParty(
  userId: string,
  disputeId: string,
): Promise<{ dispute: DisputeRow; role: "BUYER" | "VENDOR"; otherUserId: string | null; orderNumber: string }> {
  const dispute = await prisma.dispute.findUnique({
    where: { id: disputeId },
    select: {
      id: true, orderId: true, buyerId: true, vendorId: true, status: true, appealStatus: true,
      resolvedAt: true, respondByAt: true, order: { select: { orderNumber: true } },
    },
  });
  if (!dispute) throw new AppError("Dispute not found", 404);
  const vendor = await prisma.vendor.findUnique({ where: { id: dispute.vendorId }, select: { userId: true } });
  let role: "BUYER" | "VENDOR" | null = null;
  if (dispute.buyerId === userId) role = "BUYER";
  else if (vendor?.userId === userId) role = "VENDOR";
  if (!role) throw new AppError("Dispute not found", 404);
  const otherUserId = role === "BUYER" ? vendor?.userId ?? null : dispute.buyerId;
  return { dispute, role, otherUserId, orderNumber: dispute.order.orderNumber };
}

function notify(userId: string | null | undefined, title: string, body: string, disputeId: string, orderId: string, event: string): Promise<unknown> {
  if (!userId) return Promise.resolve();
  return notificationsService
    .enqueue({ userId, type: "ORDER_PAID" as never, title, body, data: { orderId, disputeId, event } as never })
    .catch(() => undefined);
}

export const SIGNED_URL_TTL_SECONDS = 300;

/**
 * Short-lived signed read for a private asset. A storage failure must never turn a
 * dispute/proof read into a 500 (or leak the provider error): the row is still returned,
 * with url null and urlUnavailable true so clients can show "file temporarily unavailable".
 */
export async function signedReadFor(assetId: string | null): Promise<{ url: string | null; contentType: string | null; urlUnavailable?: true }> {
  if (!assetId) return { url: null, contentType: null };
  const asset = await prisma.uploadAsset.findUnique({ where: { id: assetId }, select: { key: true, contentType: true } });
  if (!asset) return { url: null, contentType: null };
  try {
    return { url: await generatePresignedRead(asset.key, SIGNED_URL_TTL_SECONDS), contentType: asset.contentType };
  } catch (error) {
    logger.error("Could not sign a private asset read URL", { assetId, errorMessage: error instanceof Error ? error.message : String(error) });
    return { url: null, contentType: asset.contentType, urlUnavailable: true };
  }
}
const signed = signedReadFor;

async function withSignedUrls<T extends { uploadAssetId: string | null }>(rows: T[]) {
  return Promise.all(rows.map(async (r) => ({ ...r, ...(await signed(r.uploadAssetId)) })));
}

/** Validates an uploaded asset belongs to the submitter, is the right category and completed; attaches it. */
export async function attachUploadAsset(
  userId: string,
  assetId: string,
  category: "dispute_evidence" | "delivery_proof",
  entityType: "dispute" | "order",
  entityId: string,
): Promise<void> {
  const asset = await prisma.uploadAsset.findUnique({ where: { id: assetId } });
  if (!asset || asset.ownerId !== userId || asset.category !== category) {
    throw new AppError("Upload not found", 404);
  }
  if (asset.status !== "COMPLETED") throw new AppError("Upload is not completed yet", 409);
  if (asset.entityId && (asset.entityId !== entityId || asset.entityType !== entityType)) {
    throw new AppError("Upload is already attached elsewhere", 409);
  }
  await prisma.uploadAsset.update({ where: { id: assetId }, data: { entityType, entityId } });
}

export interface TimelineEntry { at: Date; type: string; actorRole?: string; text: string; internal?: boolean }

export function buildTimeline(
  d: {
    createdAt: Date; type: string; evidenceRequestedAt: Date | null; evidenceRequestedFrom: string | null;
    resolvedAt: Date | null; status: string; appealStatus: string; appealRequestedAt: Date | null;
    appealDecidedAt: Date | null;
  },
  evidence: { createdAt: Date; submitterRole: string; kind: string }[],
  messages: { createdAt: Date; authorRole: string; internal: boolean }[],
  includeInternal: boolean,
): TimelineEntry[] {
  const t: TimelineEntry[] = [{ at: d.createdAt, type: "OPENED", actorRole: "BUYER", text: `Dispute opened (${d.type})` }];
  for (const e of evidence) t.push({ at: e.createdAt, type: "EVIDENCE", actorRole: e.submitterRole, text: `${e.kind.toLowerCase()} evidence added` });
  for (const m of messages) {
    if (m.internal && !includeInternal) continue;
    t.push({ at: m.createdAt, type: m.internal ? "INTERNAL_NOTE" : "MESSAGE", actorRole: m.authorRole, text: m.internal ? "Internal note added" : "Message posted", internal: m.internal });
  }
  if (d.evidenceRequestedAt) t.push({ at: d.evidenceRequestedAt, type: "EVIDENCE_REQUESTED", actorRole: "ADMIN", text: `Evidence requested from ${d.evidenceRequestedFrom ?? "party"}` });
  if (d.resolvedAt) t.push({ at: d.resolvedAt, type: "RESOLVED", actorRole: "ADMIN", text: `Decision: ${d.status}` });
  if (d.appealRequestedAt) t.push({ at: d.appealRequestedAt, type: "APPEAL_REQUESTED", text: "Appeal requested" });
  if (d.appealDecidedAt) t.push({ at: d.appealDecidedAt, type: "APPEAL_DECIDED", actorRole: "ADMIN", text: `Appeal ${d.appealStatus.toLowerCase()}` });
  return t.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export const disputeV2Service = {
  /** Buyer or vendor party view. Internal notes are never returned. */
  async getForParty(userId: string, disputeId: string) {
    const { role } = await requireDisputeParty(userId, disputeId);
    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      select: {
        id: true, orderId: true, reason: true, status: true, type: true, claim: true, respondByAt: true,
        resolution: true, decisionReason: true, resolvedAt: true, refundAmount: true, appealStatus: true,
        appealReason: true, appealRequestedAt: true, appealDecidedAt: true, appealDecisionReason: true,
        evidenceRequestedAt: true, evidenceRequestedFrom: true, createdAt: true,
      },
    });
    if (!dispute) throw new AppError("Dispute not found", 404);
    const [evidence, messages] = await Promise.all([
      prisma.disputeEvidence.findMany({ where: { disputeId }, orderBy: { createdAt: "asc" } }),
      prisma.disputeMessage.findMany({ where: { disputeId, internal: false }, orderBy: { createdAt: "asc" } }),
    ]);
    return {
      ...dispute,
      yourRole: role,
      deadline: computeDeadlineState(dispute),
      appeal: { ...appealState(dispute), allowedParties: partiesAllowedToAppeal(dispute.status) },
      evidence: await withSignedUrls(evidence),
      messages,
      timeline: buildTimeline(dispute as never, evidence, messages, false),
    };
  },

  async getForPartyByOrder(userId: string, orderId: string) {
    const d = await prisma.dispute.findUnique({ where: { orderId }, select: { id: true } });
    if (!d) throw new AppError("Dispute not found", 404);
    return this.getForParty(userId, d.id);
  },

  async addEvidence(userId: string, disputeId: string, input: { kind?: unknown; uploadAssetId?: unknown; text?: unknown; note?: unknown }) {
    const { dispute, role, otherUserId, orderNumber } = await requireDisputeParty(userId, disputeId);
    if (dispute.status !== "OPEN" && dispute.appealStatus !== "REQUESTED") {
      throw new AppError("This dispute is closed to new evidence", 409);
    }
    const kind = String(input.kind ?? "").toUpperCase() as DisputeEvidenceKind;
    if (!["PHOTO", "DOCUMENT", "TEXT"].includes(kind)) throw new AppError("kind must be PHOTO, DOCUMENT or TEXT", 400);
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 1000) : null;
    let uploadAssetId: string | null = null;
    let text: string | null = null;
    if (kind === "TEXT") {
      if (typeof input.text !== "string" || input.text.trim().length < 5) throw new AppError("text evidence needs at least 5 characters", 400);
      text = input.text.trim().slice(0, 4000);
    } else {
      if (typeof input.uploadAssetId !== "string" || !input.uploadAssetId) throw new AppError("uploadAssetId is required", 400);
      await attachUploadAsset(userId, input.uploadAssetId, "dispute_evidence", "dispute", disputeId);
      uploadAssetId = input.uploadAssetId;
    }
    const created = await prisma.disputeEvidence.create({
      data: { disputeId, submittedById: userId, submitterRole: role, kind, uploadAssetId, text, note },
    });
    eventsService.emit({
      name: EVENT_NAMES.dispute_evidence_submitted, actorType: role === "BUYER" ? "user" : "vendor", actorId: userId,
      entityType: "Dispute", entityId: disputeId, secondaryEntities: { evidenceId: created.id, orderId: dispute.orderId }, source: "api",
      payload: { eventKey: `dispute_evidence_submitted:${created.id}`, kind, submitterRole: role },
    });
    await notify(otherUserId, "New dispute evidence", `New evidence was added to the dispute for order ${orderNumber}.`, disputeId, dispute.orderId, "dispute_evidence");
    return created;
  },

  async addMessage(userId: string, disputeId: string, body: unknown) {
    const { dispute, role, otherUserId, orderNumber } = await requireDisputeParty(userId, disputeId);
    if (typeof body !== "string" || body.trim().length < 2) throw new AppError("message body is required", 400);
    if (dispute.status !== "OPEN" && dispute.appealStatus !== "REQUESTED") throw new AppError("This dispute is closed to new messages", 409);
    const created = await prisma.disputeMessage.create({
      data: { disputeId, authorId: userId, authorRole: role, body: body.trim().slice(0, 4000), internal: false },
    });
    await notify(otherUserId, "New dispute message", `You have a new message on the dispute for order ${orderNumber}.`, disputeId, dispute.orderId, "dispute_message");
    return created;
  },

  /** The losing party asks for a review. Admin decides via adminDecideAppeal. */
  async requestAppeal(userId: string, disputeId: string, reason: unknown) {
    const { dispute, role, orderNumber } = await requireDisputeParty(userId, disputeId);
    if (typeof reason !== "string" || reason.trim().length < 10) throw new AppError("Appeal reason must be at least 10 characters", 400);
    if (!partiesAllowedToAppeal(dispute.status).includes(role)) throw new AppError("Only the party that lost the decision can appeal", 403);
    const st = appealState(dispute);
    if (dispute.appealStatus !== "NONE") throw new AppError("An appeal has already been filed", 409);
    if (!st.canAppeal) throw new AppError("The appeal window has closed", 409);
    const updated = await prisma.dispute.updateMany({
      where: { id: disputeId, appealStatus: "NONE" },
      data: { appealStatus: "REQUESTED", appealReason: reason.trim(), appealRequestedById: userId, appealRequestedAt: new Date() },
    });
    if (updated.count === 0) throw new AppError("An appeal has already been filed", 409);
    eventsService.emit({
      name: EVENT_NAMES.dispute_appealed, actorType: role === "BUYER" ? "user" : "vendor", actorId: userId,
      entityType: "Dispute", entityId: disputeId, secondaryEntities: { orderId: dispute.orderId }, source: "api",
      payload: { eventKey: `dispute_appealed:${disputeId}`, appellantRole: role },
    });
    const other = role === "BUYER" ? (await prisma.vendor.findUnique({ where: { id: dispute.vendorId }, select: { userId: true } }))?.userId : dispute.buyerId;
    await notify(other, "Dispute appeal filed", `The decision on order ${orderNumber} is under review after an appeal.`, disputeId, dispute.orderId, "dispute_appeal");
    return { appealStatus: "REQUESTED" as const };
  },

  // ───────────────────────── admin ─────────────────────────

  async getForAdmin(disputeId: string) {
    const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) throw new AppError("Dispute not found", 404);
    const [evidence, messages] = await Promise.all([
      prisma.disputeEvidence.findMany({ where: { disputeId }, orderBy: { createdAt: "asc" } }),
      prisma.disputeMessage.findMany({ where: { disputeId }, orderBy: { createdAt: "asc" } }),
    ]);
    return {
      deadline: computeDeadlineState(dispute),
      appeal: { ...appealState(dispute), allowedParties: partiesAllowedToAppeal(dispute.status) },
      evidence: await withSignedUrls(evidence),
      messages,
      timeline: buildTimeline(dispute, evidence, messages, true),
    };
  },

  async adminPostMessage(adminId: string, disputeId: string, body: unknown, internal: boolean) {
    if (typeof body !== "string" || body.trim().length < 5) throw new AppError("body must be at least 5 characters", 400);
    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      select: { id: true, orderId: true, buyerId: true, vendorId: true, order: { select: { orderNumber: true } } },
    });
    if (!dispute) throw new AppError("Dispute not found", 404);
    const msg = await prisma.disputeMessage.create({
      data: { disputeId, authorId: adminId, authorRole: "ADMIN", body: body.trim().slice(0, 4000), internal },
    });
    if (!internal) {
      const vendor = await prisma.vendor.findUnique({ where: { id: dispute.vendorId }, select: { userId: true } });
      const text = `Eki support posted a message on the dispute for order ${dispute.order.orderNumber}.`;
      await Promise.all([
        notify(dispute.buyerId, "Dispute update", text, disputeId, dispute.orderId, "dispute_message"),
        notify(vendor?.userId, "Dispute update", text, disputeId, dispute.orderId, "dispute_message"),
      ]);
    }
    return msg;
  },

  async adminRequestEvidence(adminId: string, disputeId: string, input: { from?: unknown; reason?: unknown; dueInDays?: unknown }) {
    const from = String(input.from ?? "").toUpperCase();
    if (from !== "BUYER" && from !== "VENDOR") throw new AppError("from must be BUYER or VENDOR", 400);
    if (typeof input.reason !== "string" || input.reason.trim().length < 5) throw new AppError("reason must be at least 5 characters", 400);
    const dueDays = typeof input.dueInDays === "number" && input.dueInDays >= 1 && input.dueInDays <= 30 ? Math.floor(input.dueInDays) : 3;
    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      select: { id: true, orderId: true, buyerId: true, vendorId: true, status: true, respondByAt: true, evidenceRequestedAt: true, evidenceRequestedFrom: true, order: { select: { orderNumber: true } } },
    });
    if (!dispute) throw new AppError("Dispute not found", 404);
    if (dispute.status !== "OPEN") throw new AppError("Dispute is already resolved", 409);
    const dueAt = new Date(Date.now() + dueDays * DAY_MS);
    await prisma.dispute.update({
      where: { id: disputeId },
      data: { evidenceRequestedAt: new Date(), evidenceRequestedFrom: from, respondByAt: dueAt },
    });
    await prisma.disputeMessage.create({
      data: { disputeId, authorId: adminId, authorRole: "ADMIN", body: `Evidence requested from ${from.toLowerCase()}: ${input.reason.trim()}`, internal: false },
    });
    const target = from === "BUYER" ? dispute.buyerId : (await prisma.vendor.findUnique({ where: { id: dispute.vendorId }, select: { userId: true } }))?.userId;
    await notify(target, "Evidence requested", `Please add evidence for the dispute on order ${dispute.order.orderNumber} by ${dueAt.toISOString().slice(0, 10)}.`, disputeId, dispute.orderId, "dispute_evidence_requested");
    return {
      before: { respondByAt: dispute.respondByAt, evidenceRequestedAt: dispute.evidenceRequestedAt, evidenceRequestedFrom: dispute.evidenceRequestedFrom },
      after: { respondByAt: dueAt, evidenceRequestedFrom: from },
    };
  },

  async adminDecideAppeal(adminId: string, disputeId: string, input: { decision?: unknown; reason?: unknown }) {
    const decision = String(input.decision ?? "").toUpperCase();
    if (decision !== "UPHELD" && decision !== "OVERTURNED") throw new AppError("decision must be UPHELD or OVERTURNED", 400);
    if (typeof input.reason !== "string" || input.reason.trim().length < 10) throw new AppError("reason must be at least 10 characters", 400);
    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      select: { id: true, orderId: true, buyerId: true, vendorId: true, appealStatus: true, order: { select: { orderNumber: true } } },
    });
    if (!dispute) throw new AppError("Dispute not found", 404);
    if (dispute.appealStatus !== "REQUESTED") throw new AppError("There is no open appeal on this dispute", 409);
    const res = await prisma.dispute.updateMany({
      where: { id: disputeId, appealStatus: "REQUESTED" },
      data: { appealStatus: decision as "UPHELD" | "OVERTURNED", appealDecidedById: adminId, appealDecidedAt: new Date(), appealDecisionReason: input.reason.trim() },
    });
    if (res.count === 0) throw new AppError("There is no open appeal on this dispute", 409);
    eventsService.emit({
      name: EVENT_NAMES.dispute_appeal_decided, actorType: "admin", actorId: adminId, entityType: "Dispute", entityId: disputeId,
      secondaryEntities: { orderId: dispute.orderId }, source: "admin",
      payload: { eventKey: `dispute_appeal_decided:${disputeId}`, decision },
    });
    const vendor = await prisma.vendor.findUnique({ where: { id: dispute.vendorId }, select: { userId: true } });
    const text = `The appeal on the dispute for order ${dispute.order.orderNumber} was ${decision.toLowerCase()}.`;
    await Promise.all([
      notify(dispute.buyerId, "Dispute appeal decided", text, disputeId, dispute.orderId, "dispute_appeal_decided"),
      notify(vendor?.userId, "Dispute appeal decided", text, disputeId, dispute.orderId, "dispute_appeal_decided"),
    ]);
    return { before: { appealStatus: "REQUESTED" }, after: { appealStatus: decision } };
  },
};
