import type { Request } from "express";
import { NotificationType, Prisma, UploadModerationStatus } from "@prisma/client";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { generatePresignedRead } from "../../lib/storage";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { adminRolesService } from "../admin/admin-roles.service";
import { notificationsService } from "../notifications/notifications.service";

/**
 * Content Review (handbook 7): an exception-based moderation queue — NOT a
 * browser of every upload. Transfer status (UploadAsset.status) is distinct from
 * moderation status (UploadAsset.moderationStatus). Private identity documents
 * are excluded from the general queue and only reachable through the
 * verification.read-gated identity view.
 */

export type ReviewTab = "flagged" | "failed" | "suspicious" | "reported" | "history";
export type ModerationAction = "approve" | "reject" | "remove" | "flag" | "contact_owner";

export const MODERATION_ACTIONS: ModerationAction[] = ["approve", "reject", "remove", "flag", "contact_owner"];

const MS = UploadModerationStatus;

/** Size limits mirror uploads.service MAX_SIZES; an upload above its category limit is "suspicious". */
const CATEGORY_MAX_BYTES: Record<string, number> = {
  product: 5 * 1024 * 1024,
  avatar: 2 * 1024 * 1024,
  cover: 5 * 1024 * 1024,
  message: 5 * 1024 * 1024,
};

const TRANSITIONS: Record<UploadModerationStatus, ModerationAction[]> = {
  [MS.NOT_REVIEWED]: ["approve", "reject", "remove", "flag", "contact_owner"],
  [MS.PENDING_REVIEW]: ["approve", "reject", "remove", "contact_owner"],
  [MS.APPROVED]: ["reject", "remove", "flag", "contact_owner"],
  [MS.REJECTED]: ["approve", "remove", "contact_owner"],
  [MS.REMOVED]: ["contact_owner"],
};

const TARGET_STATUS: Record<Exclude<ModerationAction, "contact_owner">, UploadModerationStatus> = {
  approve: MS.APPROVED,
  reject: MS.REJECTED,
  remove: MS.REMOVED,
  flag: MS.PENDING_REVIEW,
};

export function allowedActions(status: UploadModerationStatus, transfer: string, category: string): ModerationAction[] {
  if (category === "verification") return [];
  let actions = TRANSITIONS[status];
  // A file that never finished transferring has nothing to approve/reject.
  if (transfer !== "COMPLETED") actions = actions.filter((a) => a !== "approve" && a !== "reject");
  return actions;
}

export function nextModerationStatus(current: UploadModerationStatus, action: ModerationAction): UploadModerationStatus {
  if (!TRANSITIONS[current].includes(action)) {
    throw new AppError(`Cannot ${action.replace("_", " ")} content that is ${current.replace("_", " ").toLowerCase()}`, 409, undefined, "INVALID_MODERATION_TRANSITION");
  }
  return action === "contact_owner" ? current : TARGET_STATUS[action];
}

function entityTypesFor(targetType: string): string[] {
  return targetType === "store" ? ["store", "vendor"] : [targetType];
}

async function reportedClause(): Promise<Prisma.UploadAssetWhereInput | null> {
  const pending = await prisma.contentReport.findMany({
    where: { status: "PENDING" },
    select: { targetType: true, targetId: true },
    take: 500,
  });
  if (pending.length === 0) return null;
  const byType = new Map<string, Set<string>>();
  for (const r of pending) {
    const set = byType.get(r.targetType) ?? new Set<string>();
    set.add(r.targetId);
    byType.set(r.targetType, set);
  }
  return {
    OR: [...byType.entries()].map(([type, ids]) => ({ entityType: { in: entityTypesFor(type) }, entityId: { in: [...ids] } })),
  };
}

function suspiciousClause(): Prisma.UploadAssetWhereInput {
  return {
    status: "COMPLETED",
    moderationStatus: MS.NOT_REVIEWED,
    OR: [
      ...Object.entries(CATEGORY_MAX_BYTES).map(([category, max]) => ({ category, sizeBytes: { gt: max } })),
      { NOT: { contentType: { startsWith: "image/" } } },
    ],
  };
}

const NOT_IDENTITY: Prisma.UploadAssetWhereInput = { category: { not: "verification" } };

async function whereForTab(tab: ReviewTab): Promise<Prisma.UploadAssetWhereInput | null> {
  switch (tab) {
    case "flagged": return { ...NOT_IDENTITY, moderationStatus: MS.PENDING_REVIEW };
    case "failed": return { ...NOT_IDENTITY, status: "FAILED" };
    case "suspicious": return { ...NOT_IDENTITY, ...suspiciousClause() };
    case "reported": {
      const clause = await reportedClause();
      return clause ? { ...NOT_IDENTITY, AND: [clause], moderationStatus: { in: [MS.NOT_REVIEWED, MS.PENDING_REVIEW, MS.APPROVED] } } : null;
    }
    case "history": return { ...NOT_IDENTITY, moderationStatus: { in: [MS.APPROVED, MS.REJECTED, MS.REMOVED] } };
  }
}

type AssetRow = Prisma.UploadAssetGetPayload<Record<string, never>>;

async function enrich(assets: AssetRow[]) {
  const ownerIds = [...new Set(assets.map((a) => a.ownerId))];
  const owners = ownerIds.length === 0 ? [] : await prisma.user.findMany({
    where: { id: { in: ownerIds } },
    select: { id: true, name: true, email: true, role: true, vendor: { select: { id: true, storeName: true } } },
  });
  const ownerById = new Map(owners.map((o) => [o.id, o]));

  const idsOf = (types: string[]) => [...new Set(assets.filter((a) => a.entityType && types.includes(a.entityType) && a.entityId).map((a) => a.entityId!))];
  const productIds = idsOf(["product"]);
  const storeIds = idsOf(["store", "vendor", "vendor_verification"]);
  const userIds = idsOf(["user"]);
  const [products, stores, users, lastDecisions] = await Promise.all([
    productIds.length ? prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, title: true } }) : Promise.resolve([] as { id: string; title: string }[]),
    storeIds.length ? prisma.vendor.findMany({ where: { id: { in: storeIds } }, select: { id: true, storeName: true } }) : Promise.resolve([] as { id: string; storeName: string }[]),
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : Promise.resolve([] as { id: string; name: string }[]),
    assets.length ? prisma.contentDecision.findMany({
      where: { assetId: { in: assets.map((a) => a.id) } },
      orderBy: { createdAt: "desc" },
      take: assets.length * 3,
    }) : Promise.resolve([] as Prisma.ContentDecisionGetPayload<Record<string, never>>[]),
  ]);
  const productById = new Map(products.map((p) => [p.id, p.title]));
  const storeById = new Map(stores.map((s) => [s.id, s.storeName]));
  const userById = new Map(users.map((u) => [u.id, u.name]));
  const decisionByAsset = new Map<string, (typeof lastDecisions)[number]>();
  for (const d of lastDecisions) if (!decisionByAsset.has(d.assetId)) decisionByAsset.set(d.assetId, d);
  const reviewerIds = [...new Set([...decisionByAsset.values()].map((d) => d.reviewerId))];
  const reviewers = reviewerIds.length ? await prisma.user.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, name: true } }) : [];
  const reviewerById = new Map(reviewers.map((r) => [r.id, r.name]));

  return assets.map((a) => {
    const owner = ownerById.get(a.ownerId) ?? null;
    let related: { type: string; id: string | null; label: string } | null = null;
    if (a.entityType && a.entityId) {
      const label =
        a.entityType === "product" ? productById.get(a.entityId)
        : ["store", "vendor", "vendor_verification"].includes(a.entityType) ? storeById.get(a.entityId)
        : a.entityType === "user" ? userById.get(a.entityId)
        : undefined;
      related = { type: a.entityType, id: a.entityId, label: label ?? `${a.entityType} (${a.entityId.slice(0, 8)}…)` };
    } else if (a.category === "avatar") related = { type: "user", id: a.ownerId, label: `Profile photo${owner ? ` of ${owner.name}` : ""}` };
    else if (a.category === "cover") related = { type: "store", id: owner?.vendor?.id ?? null, label: `Store cover${owner?.vendor ? ` of ${owner.vendor.storeName}` : ""}` };
    const last = decisionByAsset.get(a.id);
    return {
      id: a.id,
      category: a.category,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      transferStatus: a.status,
      moderationStatus: a.moderationStatus,
      createdAt: a.createdAt,
      completedAt: a.completedAt,
      // Public assets expose their public URL as the thumbnail; private ones need an audited read-url.
      previewUrl: a.category !== "verification" && a.moderationStatus !== MS.REMOVED ? a.publicUrl : null,
      owner: owner
        ? { id: owner.id, name: owner.name, email: owner.email, role: owner.role, storeName: owner.vendor?.storeName ?? null, vendorId: owner.vendor?.id ?? null }
        : { id: a.ownerId, name: null, email: null, role: null, storeName: null, vendorId: null },
      related,
      allowedActions: allowedActions(a.moderationStatus, a.status, a.category),
      lastDecision: last
        ? { action: last.action, decision: last.decision, reason: last.reason, at: last.createdAt, reviewer: reviewerById.get(last.reviewerId) ?? null }
        : null,
    };
  });
}

async function detachContent(asset: AssetRow): Promise<string[]> {
  const detached: string[] = [];
  const url = asset.publicUrl;
  if (!url) return detached;
  try {
    if (asset.category === "avatar") {
      const r = await prisma.user.updateMany({ where: { id: asset.ownerId, avatar: url }, data: { avatar: null } });
      if (r.count) detached.push("user.avatar");
      const v = await prisma.vendor.updateMany({ where: { userId: asset.ownerId, avatar: url }, data: { avatar: null } });
      if (v.count) detached.push("vendor.avatar");
    } else if (asset.category === "cover") {
      const r = await prisma.vendor.updateMany({ where: { userId: asset.ownerId, coverImage: url }, data: { coverImage: null } });
      if (r.count) detached.push("vendor.coverImage");
    } else if (asset.category === "product") {
      const products = await prisma.product.findMany({ where: { images: { has: url } }, select: { id: true, images: true } });
      for (const p of products) {
        await prisma.product.update({ where: { id: p.id }, data: { images: p.images.filter((i) => i !== url) } });
        detached.push(`product.images:${p.id}`);
      }
    }
  } catch (error) {
    logger.warn("Content detach failed (non-blocking)", { assetId: asset.id, errorMessage: error instanceof Error ? error.message : String(error) });
  }
  return detached;
}

export const contentReviewService = {
  async counts() {
    const tabs: ReviewTab[] = ["flagged", "failed", "suspicious", "reported", "history"];
    const out: Record<string, number> = {};
    await Promise.all(tabs.map(async (t) => {
      const where = await whereForTab(t);
      out[t] = where ? await prisma.uploadAsset.count({ where }) : 0;
    }));
    const [reportsPending, identityDocs] = await Promise.all([
      prisma.contentReport.count({ where: { status: "PENDING" } }),
      prisma.uploadAsset.count({ where: { category: "verification" } }),
    ]);
    return { ...out, reports: reportsPending, identity: identityDocs };
  },

  async queue(query: { tab: ReviewTab; q?: string; category?: string; cursor?: string; limit?: number }) {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const tabWhere = await whereForTab(query.tab);
    if (!tabWhere) return { items: [], nextCursor: null as string | null };
    const where: Prisma.UploadAssetWhereInput = { ...tabWhere };
    if (query.category && query.category !== "verification") where.category = query.category;
    if (query.q && query.q.trim()) {
      const q = query.q.trim();
      const owners = await prisma.user.findMany({
        where: { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { vendor: { storeName: { contains: q, mode: "insensitive" } } }] },
        select: { id: true },
        take: 100,
      });
      where.ownerId = { in: owners.map((o) => o.id) };
    }
    const rows = await prisma.uploadAsset.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return { items: await enrich(page), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
  },

  /** Identity documents: separate, verification.read-gated list. Never previewed inline. */
  async identityDocuments(query: { q?: string; cursor?: string; limit?: number }) {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const where: Prisma.UploadAssetWhereInput = { category: "verification" };
    if (query.q && query.q.trim()) {
      const q = query.q.trim();
      const owners = await prisma.user.findMany({
        where: { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { vendor: { storeName: { contains: q, mode: "insensitive" } } }] },
        select: { id: true },
        take: 100,
      });
      where.ownerId = { in: owners.map((o) => o.id) };
    }
    const rows = await prisma.uploadAsset.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return { items: await enrich(page), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
  },

  async getAsset(id: string) {
    const asset = await prisma.uploadAsset.findUnique({ where: { id } });
    if (!asset) throw new AppError("Upload not found", 404);
    const [item] = await enrich([asset]);
    const decisions = await prisma.contentDecision.findMany({ where: { assetId: id }, orderBy: { createdAt: "desc" }, take: 50 });
    const reviewers = await prisma.user.findMany({
      where: { id: { in: [...new Set(decisions.map((d) => d.reviewerId))] } },
      select: { id: true, name: true },
    });
    const byId = new Map(reviewers.map((r) => [r.id, r.name]));
    const reports = asset.entityType && asset.entityId
      ? await prisma.contentReport.findMany({
          where: { targetType: { in: asset.entityType === "vendor" ? ["store"] : [asset.entityType] }, targetId: asset.entityId },
          orderBy: { createdAt: "desc" },
          take: 20,
        })
      : [];
    return {
      asset: item,
      decisions: decisions.map((d) => ({ ...d, reviewer: byId.get(d.reviewerId) ?? null })),
      reports,
    };
  },

  /** Audited short-lived read URL. Identity documents additionally need verification.read. */
  async readUrl(id: string, actorId: string, request?: Request) {
    const asset = await prisma.uploadAsset.findUnique({ where: { id } });
    if (!asset) throw new AppError("Upload not found", 404);
    if (asset.status !== "COMPLETED") throw new AppError("This upload never finished transferring; there is nothing to open", 404);
    if (asset.moderationStatus === MS.REMOVED) throw new AppError("This content was removed", 410);
    const identity = asset.category === "verification";
    if (identity) await adminRolesService.assertPermission(actorId, "verification.read");
    const readUrl = identity ? await generatePresignedRead(asset.key) : asset.publicUrl ?? await generatePresignedRead(asset.key);
    await recordAudit({
      actorId,
      action: identity ? "identity_document.read_url" : "content.read_url",
      entityType: "UploadAsset",
      entityId: asset.id,
      metadata: { category: asset.category, ownerId: asset.ownerId, expiresInSeconds: identity || !asset.publicUrl ? 300 : null },
      request,
    });
    return { readUrl, expiresInSeconds: 300 };
  },

  /**
   * approve / reject / remove / flag / contact_owner — each with a required reason,
   * an append-only ContentDecision, an audit entry, and (reject/remove/contact)
   * an in-app notification to the owner.
   */
  async decide(id: string, action: ModerationAction, actorId: string, reason: string, request?: Request, opts: { reportId?: string } = {}) {
    if (!MODERATION_ACTIONS.includes(action)) throw new AppError("Unknown moderation action", 400);
    const trimmed = (reason ?? "").trim();
    if (trimmed.length < 5) throw new AppError("A reason of at least 5 characters is required", 400);
    const asset = await prisma.uploadAsset.findUnique({ where: { id } });
    if (!asset) throw new AppError("Upload not found", 404);
    if (asset.category === "verification") {
      throw new AppError("Identity documents are reviewed in Verification, not Content Review", 400);
    }
    if (!allowedActions(asset.moderationStatus, asset.status, asset.category).includes(action)) {
      // Produces the specific message for the state/transition combination.
      nextModerationStatus(asset.moderationStatus, action);
      throw new AppError(`Cannot ${action.replace("_", " ")} an upload whose transfer is ${asset.status.toLowerCase()}`, 409, undefined, "INVALID_MODERATION_TRANSITION");
    }
    const next = nextModerationStatus(asset.moderationStatus, action);

    if (action !== "contact_owner") {
      // Optimistic guard: only apply if nobody else changed the status meanwhile.
      const claimed = await prisma.uploadAsset.updateMany({
        where: { id, moderationStatus: asset.moderationStatus },
        data: { moderationStatus: next },
      });
      if (claimed.count === 0) throw new AppError("This content was just updated by another reviewer. Refresh and try again.", 409);
    }
    await prisma.contentDecision.create({
      data: { assetId: id, reviewerId: actorId, decision: next, reason: trimmed, action, reportId: opts.reportId ?? null },
    });

    let detached: string[] = [];
    if (action === "remove") {
      detached = await detachContent(asset);
      // The stored object is intentionally kept (evidence); it is simply no longer served.
    }

    await recordAudit({
      actorId,
      action: `content.${action}`,
      entityType: "UploadAsset",
      entityId: id,
      reason: trimmed,
      beforeState: { moderationStatus: asset.moderationStatus },
      afterState: { moderationStatus: next, detached },
      metadata: { category: asset.category, ownerId: asset.ownerId },
      request,
    });

    if (action === "reject" || action === "remove" || action === "contact_owner") {
      const what = asset.category === "avatar" ? "profile photo" : asset.category === "cover" ? "store cover image" : asset.category === "product" ? "product image" : "upload";
      const title = action === "remove" ? `Your ${what} was removed` : action === "reject" ? `Your ${what} was not approved` : "A message from Eki about your upload";
      const body = action === "contact_owner"
        ? `Regarding your ${what}: ${trimmed}`
        : `Your ${what} ${action === "remove" ? "was removed" : "was not approved"} because it did not meet Eki's content standards. ${trimmed}`;
      await notificationsService.enqueue({
        userId: asset.ownerId,
        type: NotificationType.ADMIN_BROADCAST,
        title,
        body,
        data: { type: "content_moderation", action, assetId: id },
      }).catch((error) => logger.warn("Owner notification failed (non-blocking)", { assetId: id, errorMessage: error instanceof Error ? error.message : String(error) }));
    }

    return { ...(await contentReviewService.getAsset(id)), detached };
  },
};

