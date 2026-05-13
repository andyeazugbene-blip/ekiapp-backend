import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  createConversation,
  listConversations,
  listMessages,
  markConversationRead,
  sendMessage,
} from "./messages.controller";

export const messagesRouter = Router();

messagesRouter.use(authenticate);

messagesRouter.get("/", asyncHandler(listConversations));
messagesRouter.post("/", asyncHandler(createConversation));
messagesRouter.get("/:id/messages", asyncHandler(listMessages));
messagesRouter.post("/:id/messages", asyncHandler(sendMessage));
messagesRouter.patch("/:id/read", asyncHandler(markConversationRead));
