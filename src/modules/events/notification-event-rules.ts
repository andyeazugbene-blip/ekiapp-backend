import type { Event } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import { EVENT_NAMES } from "./events.service";

export interface ResolvedNotificationRule {
  key: string;
  version: number;
  enabled: boolean;
}

interface NotificationRuleDefinition {
  eventName: string;
  key: string;
  version: number;
  enabled: () => boolean;
}

/**
 * Explicit event-to-rule mapping for notifications on the transactional
 * outbox. Rules default off until the runtime route/approval gate is set.
 * Adding a domain event to EVENT_NAMES alone does not make it a notification.
 */
export const NOTIFICATION_EVENT_RULES: readonly NotificationRuleDefinition[] = [
  {
    eventName: EVENT_NAMES.support_response_received,
    key: "R28_SUPPORT_RESPONSE",
    version: 1,
    enabled: () => process.env.R28_GENERAL_SUPPORT_NOTIFICATIONS_ENABLED === "true",
  },
  {
    eventName: EVENT_NAMES.product_stock_depleted,
    key: "R17_STOCK_DEPLETED",
    version: 1,
    enabled: () => process.env.R17_STOCK_DEPLETED_ENABLED === "true",
  },
  {
    eventName: EVENT_NAMES.community_buy_minimum_reached,
    key: "R35_COMMUNITY_BUY_MINIMUM_REACHED",
    version: 1,
    enabled: () => true,
  },
];

export function resolveNotificationRule(event: Pick<Event, "name" | "schemaVersion">): ResolvedNotificationRule | null {
  const definition = NOTIFICATION_EVENT_RULES.find((rule) => rule.eventName === event.name);
  if (!definition) return null;
  if (event.schemaVersion !== definition.version) {
    throw new AppError(`Unsupported ${definition.key} event schema version`, 400);
  }
  return { key: definition.key, version: definition.version, enabled: definition.enabled() };
}
