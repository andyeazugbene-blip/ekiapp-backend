import { logger } from "./logger";

/**
 * Bridge to the Eki AI Automation Control Center ("ai automation italy").
 *
 * Posts account-creation events to its `POST /api/attribution/events`
 * endpoint, authenticated with the static `X-Eki-Webhook-Secret` header
 * (the Control Center's vault provider `webhooks` → `sharedSecret`). The
 * receiver dedupes by `eventId`, so a retried call is always safe.
 *
 * Optional and fail-open: with AUTOMATION_EVENTS_URL or
 * AUTOMATION_WEBHOOK_SECRET unset this is a no-op, and a slow/down/rejecting
 * Control Center never fails or noticeably delays a signup. The call is
 * awaited (bounded by a short timeout) rather than fire-and-forget because
 * this backend runs serverless on Vercel, where work left running after the
 * response is sent can be frozen before it completes.
 *
 * Privacy: only ids, role, country and acquisition fields are sent — never
 * email, name or phone. The Control Center has no contact model; if a
 * welcome/nurture flow there ever needs contact details, that is a separate,
 * consent-gated decision.
 */

const TIMEOUT_MS = 2500;

export interface SignupAttribution {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
}

const ATTRIBUTION_LIMITS: Record<keyof SignupAttribution, number> = {
  source: 80,
  medium: 80,
  campaign: 120,
  content: 120,
  term: 120,
};

/**
 * Accepts either `{ attribution: { source, medium, ... } }` or flat
 * `utm_source` / `utmSource` style fields from a request body. Unknown or
 * non-string values are dropped; returns undefined when nothing usable.
 */
export function parseSignupAttribution(raw: Record<string, unknown>): SignupAttribution | undefined {
  const nested = raw.attribution && typeof raw.attribution === "object"
    ? (raw.attribution as Record<string, unknown>)
    : {};
  const result: SignupAttribution = {};
  for (const key of Object.keys(ATTRIBUTION_LIMITS) as (keyof SignupAttribution)[]) {
    const camel = `utm${key[0].toUpperCase()}${key.slice(1)}`;
    const value = nested[key] ?? raw[`utm_${key}`] ?? raw[camel];
    if (typeof value === "string" && value.trim()) {
      result[key] = value.trim().slice(0, ATTRIBUTION_LIMITS[key]);
    }
  }
  return Object.keys(result).length ? result : undefined;
}

export interface AccountCreatedEvent {
  kind: "user_registered" | "vendor_store_created";
  userId: string;
  role: string;
  vendorId?: string;
  country?: string | null;
  signupMethod?: "password" | "google" | "apple";
  referred?: boolean;
  emailVerified?: boolean;
  isTest?: boolean;
  attribution?: SignupAttribution;
  occurredAt?: Date;
}

function eventIdFor(event: AccountCreatedEvent): string {
  return event.kind === "vendor_store_created"
    ? `eki:vendor:${event.vendorId}:store_created`
    : `eki:user:${event.userId}:registered`;
}

export async function notifyAutomationAccountCreated(event: AccountCreatedEvent): Promise<void> {
  const url = process.env.AUTOMATION_EVENTS_URL?.trim();
  const secret = process.env.AUTOMATION_WEBHOOK_SECRET?.trim();
  if (!url || !secret) return;

  const body = {
    eventId: eventIdFor(event),
    eventType: "registration",
    leadId: event.userId,
    vendorId: event.vendorId,
    source: event.attribution?.source,
    medium: event.attribution?.medium,
    campaignName: event.attribution?.campaign,
    content: event.attribution?.content,
    term: event.attribution?.term,
    occurredAt: (event.occurredAt ?? new Date()).toISOString(),
    metadata: {
      origin: "eki-marketplace",
      kind: event.kind,
      userId: event.userId,
      role: event.role,
      country: event.country ?? null,
      signupMethod: event.signupMethod ?? null,
      referred: event.referred ?? false,
      emailVerified: event.emailVerified ?? false,
      isTest: event.isTest ?? false,
    },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Eki-Webhook-Secret": secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn("Automation Control Center rejected account event", {
        eventId: body.eventId,
        status: response.status,
      });
    }
  } catch (error) {
    logger.warn("Could not deliver account event to Automation Control Center", {
      eventId: body.eventId,
      error: String(error),
    });
  }
}
