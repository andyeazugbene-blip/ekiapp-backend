import type { Request } from "express";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";

/**
 * Emergency pause for outbound communications (handbook 6.3 "emergency pause
 * for scheduled and automated outbound communications"). Stored as two
 * AdminPlatformSetting rows (value 1 = paused, 0 = running) so it is a live DB
 * read with no redeploy needed:
 *  - commsPaused:       admin broadcasts, scheduled sends and non-transactional
 *                       template sends (automation_* events) are suppressed.
 *  - automationsPaused: the Automation Engine (scheduleAutomation / sweeps).
 * Transactional messages (order/payment/verification) are never paused.
 */
export const PAUSE_KEYS = { comms: "commsPaused", automations: "automationsPaused" } as const;
export const PAUSE_REASON = "emergency_pause";

const CACHE_TTL_MS = 5_000;
let cache: { at: number; comms: boolean; automations: boolean } | null = null;

export function resetPauseCache(): void {
  cache = null;
}

async function readFlags(): Promise<{ comms: boolean; automations: boolean }> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;
  try {
    const rows = await prisma.adminPlatformSetting.findMany({
      where: { key: { in: [PAUSE_KEYS.comms, PAUSE_KEYS.automations] } },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    cache = {
      at: Date.now(),
      comms: (byKey.get(PAUSE_KEYS.comms) ?? 0) >= 1,
      automations: (byKey.get(PAUSE_KEYS.automations) ?? 0) >= 1,
    };
    return cache;
  } catch (error) {
    // Fail open: a settings read failure must not take every message down, and
    // the same DB outage would stop the sends anyway.
    logger.warn("Could not read emergency pause flags", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return { comms: false, automations: false };
  }
}

export const commsPauseService = {
  async isCommsPaused(): Promise<boolean> {
    return (await readFlags()).comms;
  },

  /** Automations stop when either flag is set (pausing comms also stops automated sends). */
  async isAutomationsPaused(): Promise<boolean> {
    const f = await readFlags();
    return f.comms || f.automations;
  },

  async getState(): Promise<{
    commsPaused: boolean;
    automationsPaused: boolean;
    updatedAt: Date | null;
    updatedById: string | null;
  }> {
    cache = null;
    const rows = await prisma.adminPlatformSetting.findMany({
      where: { key: { in: [PAUSE_KEYS.comms, PAUSE_KEYS.automations] } },
      orderBy: { updatedAt: "desc" },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    return {
      commsPaused: (byKey.get(PAUSE_KEYS.comms) ?? 0) >= 1,
      automationsPaused: (byKey.get(PAUSE_KEYS.automations) ?? 0) >= 1,
      updatedAt: rows[0]?.updatedAt ?? null,
      updatedById: rows[0]?.updatedById ?? null,
    };
  },

  async setState(
    input: { commsPaused?: boolean; automationsPaused?: boolean },
    actorId: string,
    reason: string,
    request?: Request,
  ) {
    const trimmed = (reason ?? "").trim();
    if (trimmed.length < 5) throw new AppError("A reason of at least 5 characters is required", 400);
    if (input.commsPaused === undefined && input.automationsPaused === undefined) {
      throw new AppError("commsPaused or automationsPaused is required", 400);
    }
    const before = await commsPauseService.getState();
    const writes: Array<[string, boolean]> = [];
    if (input.commsPaused !== undefined) writes.push([PAUSE_KEYS.comms, input.commsPaused]);
    if (input.automationsPaused !== undefined) writes.push([PAUSE_KEYS.automations, input.automationsPaused]);
    for (const [key, paused] of writes) {
      await prisma.adminPlatformSetting.upsert({
        where: { key },
        update: { value: paused ? 1 : 0, updatedById: actorId },
        create: { key, value: paused ? 1 : 0, updatedById: actorId },
      });
    }
    cache = null;
    const after = await commsPauseService.getState();
    await recordAudit({
      actorId,
      action: "communications.emergency_pause",
      entityType: "AdminPlatformSetting",
      beforeState: { commsPaused: before.commsPaused, automationsPaused: before.automationsPaused },
      afterState: { commsPaused: after.commsPaused, automationsPaused: after.automationsPaused },
      reason: trimmed,
      request,
    });
    return after;
  },
};
