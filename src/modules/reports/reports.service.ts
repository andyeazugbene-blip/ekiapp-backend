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

// Admin: list reports — enriched with the reporter's real name/email so a
// moderator has something actionable to look at, not a bare reporterId.
// Apple 1.2 (User-Generated Content) requires "a mechanism to report
// offensive content and timely responses to concerns" — an admin page with
// no way to identify who reported what isn't a usable moderation queue.
export async function listReports(status?: string) {
  const reports = await prisma.contentReport.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const reporterIds = [...new Set(reports.map((r) => r.reporterId))];
  const reporters = await prisma.user.findMany({
    where: { id: { in: reporterIds } },
    select: { id: true, name: true, email: true },
  });
  const reporterById = new Map(reporters.map((r) => [r.id, r]));
  return reports.map((r) => ({ ...r, reporter: reporterById.get(r.reporterId) ?? null }));
}

// Admin: update report status
export async function reviewReport(reportId: string, status: string, reviewedBy: string) {
  return prisma.contentReport.update({
    where: { id: reportId },
    data: { status, reviewedBy, reviewedAt: new Date() },
  });
}
