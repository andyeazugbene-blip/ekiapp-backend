import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { parseIncludeTest } from "../../shared/utils/test-records";
import { adminDashboardService } from "./admin-dashboard.service";
import { adminSearchService } from "./admin-search.service";
import { adminTestFlagsService, type TestFlagEntity, type TestFlagResult } from "./admin-test-flags.service";
import { requireReason } from "./admin-suspension.service";

function viewerId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

/** GET /admin/dashboard/action-centre?includeTest= */
export async function getActionCentre(request: Request, response: Response): Promise<void> {
  const data = await adminDashboardService.getActionCentre(viewerId(request), {
    includeTest: parseIncludeTest(request.query.includeTest),
  });
  response.status(200).json(data);
}

/** GET /admin/search?q= — permission-filtered per entity group. */
export async function searchAdmin(request: Request, response: Response): Promise<void> {
  const q = typeof request.query.q === "string" ? request.query.q : "";
  const data = await adminSearchService.search(viewerId(request), q);
  response.status(200).json(data);
}

const ENTITY_TYPE: Record<TestFlagEntity, string> = { user: "User", vendor: "Vendor", order: "Order" };

/** PATCH /admin/{users|vendors|orders}/:id/test-flag  body { isTest: boolean, reason } */
export function setTestFlag(entity: TestFlagEntity) {
  return async (request: Request, response: Response): Promise<void> => {
    const actorId = viewerId(request);
    const id = String(request.params.id);
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.isTest !== "boolean") throw new AppError("isTest must be a boolean", 400);
    const reason = requireReason(body.reason);

    let result: TestFlagResult;
    if (entity === "user") result = await adminTestFlagsService.setUserTest(id, body.isTest);
    else if (entity === "vendor") result = await adminTestFlagsService.setVendorTest(id, body.isTest);
    else result = await adminTestFlagsService.setOrderTest(id, body.isTest);

    await recordAudit({
      actorId,
      action: body.isTest ? `${entity}.flag_test` : `${entity}.unflag_test`,
      entityType: ENTITY_TYPE[entity],
      entityId: id,
      reason,
      request,
      beforeState: { isTest: result.before.isTest },
      afterState: { isTest: result.isTest },
      metadata: { cascade: result.affected },
    });
    response.status(200).json({ id, isTest: result.isTest, affected: result.affected });
  };
}
