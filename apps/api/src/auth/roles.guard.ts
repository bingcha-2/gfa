import { Injectable, CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { ROLES_KEY } from "./roles.decorator";
import { PERMISSIONS_KEY } from "./permissions.decorator";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest();

    // SUPER_ADMIN bypasses ALL role and permission checks
    if (user?.role === "SUPER_ADMIN") {
      return true;
    }

    // --- Role check ---
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (requiredRoles && requiredRoles.length > 0) {
      if (!requiredRoles.includes(user?.role)) {
        return false;
      }
    }

    // --- Permission check ---
    const requiredPerms = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (requiredPerms && requiredPerms.length > 0) {
      // Parse user permissions from JWT (null/undefined = all permissions)
      const userPerms: string[] | null = user?.permissions ?? null;
      if (userPerms === null) {
        // null permissions = full access (for backward compat)
        return true;
      }
      // User must have at least one of the required permissions
      return requiredPerms.some((p) => userPerms.includes(p));
    }

    return true;
  }
}
