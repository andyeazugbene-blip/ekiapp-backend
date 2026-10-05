import { ConversationType } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import type {
  CreateConversationInput,
  ListConversationsQuery,
  ListMessagesQuery,
  ListSupportConversationsQuery,
  SendMessageInput,
  StartSupportConversationInput,
  AdminSupportListQuery,
  AdminReplyInput,
  SupportLifecycleInput,
} from "./messages.types";

const CONVERSATION_TYPES = new Set<string>(Object.values(ConversationType));
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;
const MAX_ATTACHMENTS = 5;
const MIN_REASON_LENGTH = 5;

function isHttpUrl(value: string): boolean {
  return value.length <= 2048 && /^https?:\/\//i.test(value);
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
    throw new AppError(`Invalid limit (1-${MAX_LIMIT})`, 400);
  }
  return parsed;
}

function flag(raw: unknown): boolean | undefined {
  return raw === "true" || raw === "1" ? true : undefined;
}

export function validateCreateConversationInput(input: unknown): CreateConversationInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.participantId !== "string" || raw.participantId.trim().length === 0) {
    throw new AppError("Invalid participantId", 400);
  }

  let type: ConversationType | undefined;
  if (raw.type !== undefined) {
    if (typeof raw.type !== "string" || !CONVERSATION_TYPES.has(raw.type)) {
      throw new AppError("Invalid conversation type", 400);
    }
    type = raw.type as ConversationType;
  }

  const orderId =
    typeof raw.orderId === "string" && raw.orderId.trim().length > 0
      ? raw.orderId.trim()
      : undefined;

  const initialMessage =
    typeof raw.initialMessage === "string" && raw.initialMessage.trim().length > 0
      ? raw.initialMessage.trim()
      : undefined;

  return {
    participantId: raw.participantId.trim(),
    type,
    orderId,
    initialMessage,
  };
}

export function validateSendMessageInput(input: unknown): SendMessageInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.text !== "string" || raw.text.trim().length === 0) {
    throw new AppError("Message text is required", 400);
  }

  let attachments: string[] | undefined;
  if (raw.attachments !== undefined) {
    if (!Array.isArray(raw.attachments)) {
      throw new AppError("Invalid attachments", 400);
    }
    // http(s) only: attachments are rendered as links in the admin panel and
    // the apps, so javascript:/data: schemes must never be stored.
    attachments = raw.attachments
      .filter((a): a is string => typeof a === "string" && isHttpUrl(a.trim()))
      .map((a) => a.trim())
      .slice(0, MAX_ATTACHMENTS);
  }

  return {
    text: raw.text.trim(),
    attachments,
  };
}

export function validateListConversationsQuery(query: Record<string, unknown>): ListConversationsQuery {
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
      throw new AppError(`Invalid limit (1-${MAX_LIMIT})`, 400);
    }
    limit = parsed;
  }
  const cursor =
    typeof query.cursor === "string" && query.cursor.length > 0 ? query.cursor : undefined;
  return { limit, cursor };
}

export function validateListMessagesQuery(query: Record<string, unknown>): ListMessagesQuery {
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
      throw new AppError(`Invalid limit (1-${MAX_LIMIT})`, 400);
    }
    limit = parsed;
  }
  const cursor =
    typeof query.cursor === "string" && query.cursor.length > 0 ? query.cursor : undefined;
  return { limit, cursor };
}

export function validateStartSupportConversationInput(input: unknown): StartSupportConversationInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.message !== "string" || raw.message.trim().length === 0) {
    throw new AppError("A message is required", 400);
  }
  return { message: raw.message.trim() };
}

export function validateListSupportConversationsQuery(query: Record<string, unknown>): ListSupportConversationsQuery {
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
      throw new AppError(`Invalid limit (1-${MAX_LIMIT})`, 400);
    }
    limit = parsed;
  }
  const cursor =
    typeof query.cursor === "string" && query.cursor.length > 0 ? query.cursor : undefined;
  return { limit, cursor };
}

export function validateAdminSupportListQuery(query: Record<string, unknown>): AdminSupportListQuery {
  const limit = parseLimit(query.limit);
  const cursor = typeof query.cursor === "string" && query.cursor.length > 0 ? query.cursor : undefined;
  const statusRaw = typeof query.status === "string" ? query.status.toLowerCase() : "all";
  if (statusRaw !== "open" && statusRaw !== "closed" && statusRaw !== "all") {
    throw new AppError("Invalid status (open, closed, all)", 400);
  }
  let role: "buyer" | "vendor" | undefined;
  if (typeof query.role === "string" && query.role.length > 0 && query.role !== "all") {
    const r = query.role.toLowerCase();
    if (r !== "buyer" && r !== "vendor") throw new AppError("Invalid role (buyer, vendor)", 400);
    role = r;
  }
  const q = typeof query.q === "string" && query.q.trim().length > 0 ? query.q.trim().slice(0, 100) : undefined;
  const orderId = typeof query.orderId === "string" && query.orderId.trim().length > 0 ? query.orderId.trim() : undefined;
  return {
    limit,
    cursor,
    status: statusRaw,
    unread: flag(query.unread),
    escalated: flag(query.escalated),
    reported: flag(query.reported),
    orderLinked: flag(query.orderLinked),
    orderId,
    role,
    q,
  };
}

export function validateAdminReplyInput(input: unknown): AdminReplyInput {
  if (!input || typeof input !== "object") throw new AppError("Invalid request body", 400);
  const raw = input as Record<string, unknown>;
  if (typeof raw.text !== "string" || raw.text.trim().length === 0) {
    throw new AppError("Message text is required", 400);
  }
  if (raw.text.length > 5000) throw new AppError("Message is too long (max 5000 characters)", 400);
  let attachments: string[] = [];
  if (raw.attachments !== undefined) {
    if (!Array.isArray(raw.attachments)) throw new AppError("Invalid attachments", 400);
    attachments = raw.attachments.map((a) => (typeof a === "string" ? a.trim() : ""));
    if (attachments.some((a) => !isHttpUrl(a))) throw new AppError("Attachments must be http(s) URLs", 400);
    if (attachments.length > MAX_ATTACHMENTS) throw new AppError(`At most ${MAX_ATTACHMENTS} attachments`, 400);
  }
  return { text: raw.text.trim(), attachments, isInternal: raw.isInternal === true };
}

export function validateSupportLifecycleInput(input: unknown): SupportLifecycleInput {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (reason.length < MIN_REASON_LENGTH) {
    throw new AppError(`A reason of at least ${MIN_REASON_LENGTH} characters is required`, 400);
  }
  if (reason.length > 500) throw new AppError("Reason is too long (max 500 characters)", 400);
  return { reason };
}
