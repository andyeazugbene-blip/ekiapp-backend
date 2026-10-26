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
    eventName: EVENT_NAMES.payment_failed,
    key: "R20_PAYMENT_FAILED",
    version: 1,
    enabled: () => process.env.R20_PAYMENT_FAILED_ENABLED === "true",
  },
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
    eventName: EVENT_NAMES.product_inventory_conflict_detected,
    key: "R18_STOCK_CONFLICT",
    version: 1,
    enabled: () => process.env.R18_STOCK_CONFLICT_ENABLED === "true",
  },
  {
    eventName: EVENT_NAMES.community_buy_minimum_reached,
    key: "R35_COMMUNITY_BUY_MINIMUM_REACHED",
    version: 1,
    enabled: () => true,
  },
  {
    eventName: EVENT_NAMES.community_buy_payment_action_required,
    key: "R36_COMMUNITY_BUY_PAYMENT_ACTION_REQUIRED",
    version: 1,
    enabled: () => process.env.R36_COMMUNITY_BUY_PAYMENT_ACTION_REQUIRED_ENABLED === "true",
  },
  {
    eventName: EVENT_NAMES.community_buy_supplier_reconfirmation_requested,
    key: "R37_SUPPLIER_RECONFIRMATION",
    version: 1,
    enabled: () => process.env.R37_SUPPLIER_RECONFIRMATION_ENABLED === "true",
  },
  {
    eventName: EVENT_NAMES.payout_action_required,
    key: "R25_PAYOUT_ACTION_REQUIRED",
    version: 1,
    enabled: () => process.env.R25_PAYOUT_ACTION_REQUIRED_ENABLED === "true",
  },
  {
    eventName: EVENT_NAMES.vendor_membership_payment_failed,
    key: "R29_MEMBERSHIP_PAYMENT_FAILED",
    version: 1,
    enabled: () => process.env.R29_MEMBERSHIP_PAYMENT_FAILED_ENABLED === "true",
  },
  {
    eventName: EVENT_NAMES.community_buy_below_minimum,
    key: "R34_COMMUNITY_BUY_BELOW_MINIMUM",
    version: 1,
    enabled: () => process.env.R34_COMMUNITY_BUY_BELOW_MINIMUM_ENABLED === "true",
  },
  {
    eventName: EVENT_NAMES.payout_confirmed,
    key: "R26_PAYOUT_CONFIRMED",
    version: 1,
    enabled: () => process.env.R26_PAYOUT_CONFIRMED_ENABLED === "true",
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
