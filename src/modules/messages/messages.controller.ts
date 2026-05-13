import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { messagesService } from "./messages.service";
import {
  validateCreateConversationInput,
  validateListConversationsQuery,
  validateListMessagesQuery,
  validateSendMessageInput,
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
