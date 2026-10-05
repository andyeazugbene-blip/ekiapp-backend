import type { AutomationRuleState } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

export interface RuleGate {
  /** false when the rule is not ACTIVE (paused, archived, draft, test, failed). */
  runnable: boolean;
  state: AutomationRuleState | null;
  /** Suppression reason to record when not runnable. */
  reason: string | null;
  /** Enforced timing overrides from the rule, if any. */
  timing: { frequencyCapDays?: number; quietHoursStartUtc?: number; quietHoursEndUtc?: number } | null;
}

export function reasonForState(state: AutomationRuleState): string {
  if (state === "PAUSED") return "rule_paused";
  if (state === "ARCHIVED") return "rule_archived";
  return `rule_${state.toLowerCase()}`; // rule_draft / rule_test / rule_failed
}

/**
 * Reads the AutomationRule governing an automation type (key === type name).
 * No row (not yet seeded) or a read failure fails OPEN so existing behaviour is
 * unchanged until an admin pauses something.
 */
export async function getRuleGate(ruleKey: string): Promise<RuleGate> {
  try {
    const rule = await prisma.automationRule.findUnique({
      where: { key: ruleKey },
      select: { state: true, timing: true },
    });
    if (!rule) return { runnable: true, state: null, reason: null, timing: null };
    const timing = (rule.timing as RuleGate["timing"]) ?? null;
    if (rule.state === "ACTIVE") return { runnable: true, state: rule.state, reason: null, timing };
    return { runnable: false, state: rule.state, reason: reasonForState(rule.state), timing };
  } catch (error) {
    logger.warn("Automation rule gate read failed — failing open", { ruleKey, error: error instanceof Error ? error.message : String(error) });
    return { runnable: true, state: null, reason: null, timing: null };
  }
}

/** Best-effort bookkeeping; never throws. */
export async function noteRuleSkipped(ruleKey: string, reason: string): Promise<void> {
  try {
    await prisma.automationRule.updateMany({ where: { key: ruleKey }, data: { lastSkippedAt: new Date(), lastSkipReason: reason } });
  } catch {
    /* ignore */
  }
}

export async function noteRuleRan(ruleKey: string): Promise<void> {
  try {
    await prisma.automationRule.updateMany({ where: { key: ruleKey }, data: { lastRunAt: new Date() } });
  } catch {
    /* ignore */
  }
}
