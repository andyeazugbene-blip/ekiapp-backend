import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { messagesService } from "./messages.service";
import { supportInboxService } from "./support-inbox.service";
import {
  validateCreateConversationInput,
  validateListConversationsQuery,
  validateListMessagesQuery,
  validateAdminReplyInput,
  validateAdminSupportListQuery,
  validateSupportLifecycleInput,
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

// ─── Admin shared support inbox (routes: admin.routes.ts, support.read / support.mutate) ───

function requireAdminId(request: Request): string {
  return requireUserId(request);
}

export async function adminListSupportConversations(request: Request, response: Response): Promise<void> {
  const query = validateAdminSupportListQuery(request.query as Record<string, unknown>);
  response.status(200).json(await supportInboxService.list(query));
}

export async function adminGetSupportConversation(request: Request, response: Response): Promise<void> {
  response.status(200).json({ conversation: await supportInboxService.get(requireIdParam(request)) });
}

export async function adminListSupportMessages(request: Request, response: Response): Promise<void> {
  const query = validateListMessagesQuery(request.query as Record<string, unknown>);
  response.status(200).json(await supportInboxService.listMessages(requireIdParam(request), query));
}

export async function adminReplySupportConversation(request: Request, response: Response): Promise<void> {
  const input = validateAdminReplyInput(request.body);
  const message = await supportInboxService.sendReply(requireAdminId(request), requireIdParam(request), input, request);
  response.status(201).json({ message });
}

function lifecycleHandler(action: "close" | "reopen" | "escalate" | "deescalate") {
  return async (request: Request, response: Response): Promise<void> => {
    const { reason } = validateSupportLifecycleInput(request.body);
    const conversation = await supportInboxService.transition(action, requireAdminId(request), requireIdParam(request), reason, request);
    response.status(200).json({ conversation });
  };
}

export const adminCloseSupportConversation = lifecycleHandler("close");
export const adminReopenSupportConversation = lifecycleHandler("reopen");
export const adminEscalateSupportConversation = lifecycleHandler("escalate");
export const adminDeescalateSupportConversation = lifecycleHandler("deescalate");
