import { ConversationType } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import type {
  CreateConversationInput,
  ListConversationsQuery,
  ListMessagesQuery,
  SendMessageInput,
} from "./messages.types";

const CONVERSATION_TYPES = new Set<string>(Object.values(ConversationType));
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

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
    attachments = raw.attachments.filter(
      (a): a is string => typeof a === "string" && a.trim().length > 0,
    );
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
