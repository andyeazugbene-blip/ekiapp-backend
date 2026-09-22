import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { messagesService } from "./messages.service";
import {
  validateCreateConversationInput,
  validateListConversationsQuery,
  validateListMessagesQuery,
  validateListSupportConversationsQuery,
  validateSendMessageInput,
  validateStartSupportConversationInput,
} from "./messages.validation";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new AppError("Invalid id", 400);
  }
  return id;
}

export async function createConversation(request: Request, response: Response): Promise<void> {
  const input = validateCreateConversationInput(request.body);
  const conversation = await messagesService.createConversation(requireUserId(request), input);
  response.status(201).json({ conversation });
}

export async function listConversations(request: Request, response: Response): Promise<void> {
  const query = validateListConversationsQuery(request.query as Record<string, unknown>);
  const result = await messagesService.listConversations(requireUserId(request), query);
  response.status(200).json(result);
}

export async function listMessages(request: Request, response: Response): Promise<void> {
  const query = validateListMessagesQuery(request.query as Record<string, unknown>);
  const result = await messagesService.listMessages(
    requireUserId(request),
    requireIdParam(request),
    query,
  );
  response.status(200).json(result);
}

export async function sendMessage(request: Request, response: Response): Promise<void> {
  const input = validateSendMessageInput(request.body);
  const message = await messagesService.sendMessage(
    requireUserId(request),
    requireIdParam(request),
    input,
  );
  response.status(201).json({ message });
}

export async function markConversationRead(request: Request, response: Response): Promise<void> {
  await messagesService.markConversationRead(requireUserId(request), requireIdParam(request));
  response.status(200).json({ success: true });
}

/** Buyer-facing (and any authenticated user's) "Contact us" entry point — see messages.service.ts's startSupportConversation() for why no admin id is ever supplied by the client. */
export async function startSupportConversation(request: Request, response: Response): Promise<void> {
  const input = validateStartSupportConversationInput(request.body);
  const conversation = await messagesService.startSupportConversation(requireUserId(request), input.message);
  response.status(201).json({ conversation });
}

/** Admin-only — see admin.routes.ts (requireAdminPermission("support.read")); this file, not admin's own controller, to stay next to the service functions it wraps. */
export async function adminListSupportConversations(request: Request, response: Response): Promise<void> {
  const query = validateListSupportConversationsQuery(request.query as Record<string, unknown>);
  const result = await messagesService.listSupportConversationsForAdmin(query);
  response.status(200).json(result);
}

export async function adminGetSupportConversation(request: Request, response: Response): Promise<void> {
  const conversation = await messagesService.getSupportConversationForAdmin(requireIdParam(request));
  response.status(200).json({ conversation });
}
