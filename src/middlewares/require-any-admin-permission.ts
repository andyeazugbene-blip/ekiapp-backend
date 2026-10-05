import type { NextFunction, Request, Response } from "express";

import { AppError } from "../shared/errors/app-error";
import { adminRolesService } from "../modules/admin/admin-roles.service";

/**
 * Passes when the admin holds ANY of the listed permissions. Used where a new
 * permission (content.*) replaces an older one (reports.*) without locking out
 * roles that were configured with the old name.
 */
export function requireAnyAdminPermission(...permissions: string[]) {
  return async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      if (!request.user) throw new AppError("Unauthorized", 401);
      let lastError: unknown = null;
      for (const permission of permissions) {
        try {
          await adminRolesService.assertPermission(request.user.id, permission);
          request.usedPermission = permission;
          next();
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new AppError("Admin role does not have permission for this action", 403, null, "ADMIN_PERMISSION_DENIED");
    } catch (error) {
      next(error);
    }
  };
}
