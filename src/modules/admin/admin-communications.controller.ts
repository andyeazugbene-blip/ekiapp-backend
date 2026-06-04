import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { adminCommunicationsService } from "./admin-communications.service";

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

export async function sendAdminBroadcast(request: Request, response: Response): Promise<void> {
  const actorId = requireUserId(request);
  const input = adminCommunicationsService.normalizeInput(request.body);
  const result = await adminCommunicationsService.broadcast(actorId, input);
  await recordAudit({
    actorId,
    action: "admin.broadcast",
    entityType: "Broadcast",
    metadata: {
      audience: input.audience,
      channel: input.channel,
      sent: result.sent,
      messagesCreated: result.messagesCreated,
    },
  });
  response.status(202).json(result);
}
