import type { NextFunction, Request, Response } from "express";

import { AppError } from "../shared/errors/app-error";
import { adminRolesService } from "../modules/admin/admin-roles.service";

export function requireAdminPermission(permission: string) {
  return async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      if (!request.user) throw new AppError("Unauthorized", 401);
      await adminRolesService.assertPermission(request.user.id, permission);
      next();
    } catch (error) {
      next(error);
    }
  };
}
