import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  getNotificationPreferences, getUnreadNotificationCount, listNotifications, markAllNotificationsRead, markNotificationRead,
  testPushNotification, updateNotificationPreferences,
} from "./notifications.controller";

export const notificationsRouter = Router();

notificationsRouter.use(authenticate);

notificationsRouter.get("/", asyncHandler(listNotifications));
notificationsRouter.get("/unread-count", asyncHandler(getUnreadNotificationCount));
notificationsRouter.get("/preferences", asyncHandler(getNotificationPreferences));
notificationsRouter.patch("/preferences", asyncHandler(updateNotificationPreferences));
notificationsRouter.patch("/read-all", asyncHandler(markAllNotificationsRead));
notificationsRouter.patch("/:id/read", asyncHandler(markNotificationRead));
notificationsRouter.post("/test-push", asyncHandler(testPushNotification));
