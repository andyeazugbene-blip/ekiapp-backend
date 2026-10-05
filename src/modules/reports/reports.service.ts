import { prisma } from "../../lib/prisma";

export interface CreateReportInput {
  reporterId: string;
  targetType: string;
  targetId: string;
  reason: string;
  details?: string;
}

export async function createReport(input: CreateReportInput) {
  // Prevent duplicate reports from same user on same target
  const existing = await prisma.contentReport.findFirst({
    where: {
      reporterId: input.reporterId,
      targetType: input.targetType,
      targetId: input.targetId,
      status: "PENDING",
    },
  });
  if (existing) return existing;

  return prisma.contentReport.create({ data: input });
}

export async function blockUser(blockerId: string, blockedId: string) {
  if (blockerId === blockedId) throw new Error("Cannot block yourself");
  return prisma.userBlock.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    create: { blockerId, blockedId },
    update: {},
  });
}

export async function unblockUser(blockerId: string, blockedId: string) {
  return prisma.userBlock.deleteMany({
    where: { blockerId, blockedId },
  });
}

export async function getBlockedUsers(blockerId: string) {
  return prisma.userBlock.findMany({
    where: { blockerId },
    orderBy: { createdAt: "desc" },
  });
}

export async function isBlocked(blockerId: string, blockedId: string): Promise<boolean> {
  const block = await prisma.userBlock.findUnique({
    where: { blockerId_blockedId: { blockerId, blockedId } },
  });
  return !!block;
}

// Admin: list reports — enriched with the reporter, reviewer and a human label
// for the reported target so a moderator has something actionable to look at,
// not bare ids. Apple 1.2 (User-Generated Content) requires a mechanism to
// report offensive content and timely responses to concerns.
export async function listReports(status?: string, opts: { cursor?: string; limit?: number; targetType?: string } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const rows = await prisma.contentReport.findMany({
    where: { ...(status ? { status } : {}), ...(opts.targetType ? { targetType: opts.targetType } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const reports = rows.slice(0, limit);
  const userIds = [...new Set(reports.flatMap((r) => [r.reporterId, r.reviewedBy].filter((x): x is string => !!x)))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  const idsOf = (t: string) => [...new Set(reports.filter((r) => r.targetType === t).map((r) => r.targetId))];
  const [products, vendors, reviews, messages] = await Promise.all([
    idsOf("product").length ? prisma.product.findMany({ where: { id: { in: idsOf("product") } }, select: { id: true, title: true } }) : [],
    idsOf("store").length ? prisma.vendor.findMany({ where: { OR: [{ id: { in: idsOf("store") } }, { storeSlug: { in: idsOf("store") } }] }, select: { id: true, storeSlug: true, storeName: true } }) : [],
    idsOf("review").length ? prisma.review.findMany({ where: { id: { in: idsOf("review") } }, select: { id: true, comment: true } }) : [],
    idsOf("message").length ? prisma.message.findMany({ where: { id: { in: idsOf("message") } }, select: { id: true, text: true } }) : [],
  ]);
  const labels = new Map<string, string>();
  for (const p of products) labels.set(`product:${p.id}`, p.title);
  for (const v of vendors) { labels.set(`store:${v.id}`, v.storeName); labels.set(`store:${v.storeSlug}`, v.storeName); }
  for (const r of reviews) labels.set(`review:${r.id}`, r.comment ? `Review: "${r.comment.slice(0, 80)}"` : "Review (no text)");
  for (const m of messages) labels.set(`message:${m.id}`, `Message: "${m.text.slice(0, 80)}"`);

  return {
    reports: reports.map((r) => ({
      ...r,
      reporter: userById.get(r.reporterId) ?? null,
      reviewer: r.reviewedBy ? userById.get(r.reviewedBy) ?? null : null,
      targetLabel: labels.get(`${r.targetType}:${r.targetId}`) ?? null,
    })),
    nextCursor: rows.length > limit ? reports[reports.length - 1].id : null,
  };
}

// Admin: update report status (reason is recorded on the report and in the audit log)
export async function reviewReport(reportId: string, status: string, reviewedBy: string, reason: string) {
  return prisma.contentReport.update({
    where: { id: reportId },
    data: { status, reviewedBy, reviewedAt: new Date(), decisionReason: reason },
  });
}
