import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  createConversation,
  listConversations,
  listMessages,
  markConversationRead,
  sendMessage,
  startSupportConversation,
} from "./messages.controller";

export const messagesRouter = Router();

messagesRouter.use(authenticate);

messagesRouter.get("/", asyncHandler(listConversations));
messagesRouter.post("/", asyncHandler(createConversation));
// In-app support ("Contact us") — before "/:id/messages" only matters if
// Express could confuse a literal "support" segment with an :id param; it
// can't (different path shapes), but declared first for readability.
messagesRouter.post("/support", asyncHandler(startSupportConversation));
messagesRouter.get("/:id/messages", asyncHandler(listMessages));
messagesRouter.post("/:id/messages", asyncHandler(sendMessage));
messagesRouter.patch("/:id/read", asyncHandler(markConversationRead));
