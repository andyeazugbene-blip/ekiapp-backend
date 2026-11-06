import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

/** Upper-cases a partner code. A malformed one is dropped, because attribution must never block a sign-up. */
export function normalisePartnerCode(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const code = raw.trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : undefined;
}

export const partnerCohortsService = {
  /** One row per partner code: sign-ups, stores created and stores with a first paid order. */
  async list() {
    const groups = await prisma.user.groupBy({
      by: ["partnerCode"],
      where: { partnerCode: { not: null }, isTest: false },
      _count: { _all: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
    });
    const rows = await Promise.all(
      groups.map(async (group) => {
        const code = group.partnerCode as string;
        const [stores, storesWithSale] = await Promise.all([
          prisma.vendor.count({ where: { isTest: false, user: { partnerCode: code } } }),
          prisma.vendor.count({ where: { isTest: false, user: { partnerCode: code }, orderItems: { some: { order: { payment: { status: "SUCCEEDED" } } } } } }),
        ]);
        return {
          code,
          signUps: group._count._all,
          stores,
          storesWithSale,
          firstSignUpAt: group._min.createdAt,
          lastSignUpAt: group._max.createdAt,
        };
      }),
    );
    return rows.sort((a, b) => b.signUps - a.signUps || a.code.localeCompare(b.code));
  },

  /** The accounts behind one code, without contact details: enough to check a partner's report. */
  async detail(rawCode: string) {
    const code = normalisePartnerCode(rawCode);
    if (!code) throw new AppError("Unknown partner code", 404);
    const users = await prisma.user.findMany({
      where: { partnerCode: code, isTest: false },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, createdAt: true, country: true, vendor: { select: { storeName: true } } },
    });
    return {
      code,
      accounts: users.map((u) => ({ userId: u.id, signedUpAt: u.createdAt, country: u.country, store: u.vendor?.storeName ?? null })),
    };
  },
};
