import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Request, ForbiddenException, BadRequestException
} from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { Roles } from "./roles.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogService } from "../audit-log/audit-log.service";

const VALID_ROLES = ["ADMIN", "OPERATIONS", "SUPPORT"];
const VALID_PERMISSIONS = [
  "overview", "daily_stats", "accounts", "groups",
  "orders", "tasks", "codes", "expire", "scheduler", "lookup"
];

@Controller("users")
export class UserController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService
  ) {}

  // Only SUPER_ADMIN can manage users (enforced by RolesGuard since only SUPER_ADMIN bypasses + we set @Roles here)
  @Get()
  @Roles("SUPER_ADMIN")
  async listUsers() {
    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        permissions: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return users.map((u) => ({
      ...u,
      permissions: u.permissions ? JSON.parse(u.permissions) : null,
    }));
  }

  @Post()
  @Roles("SUPER_ADMIN")
  async createUser(@Request() req: any, @Body() body: {
    email: string;
    displayName: string;
    password: string;
    role: string;
    permissions?: string[];
  }) {
    if (!body.email || !body.password || !body.displayName || !body.role) {
      throw new BadRequestException("Missing required fields: email, password, displayName, role");
    }

    if (!VALID_ROLES.includes(body.role)) {
      throw new BadRequestException(`Invalid role. Must be one of: ${VALID_ROLES.join(", ")}`);
    }

    if (body.password.length < 6) {
      throw new BadRequestException("Password must be at least 6 characters");
    }

    // Validate permissions
    if (body.permissions) {
      const invalid = body.permissions.filter((p) => !VALID_PERMISSIONS.includes(p));
      if (invalid.length > 0) {
        throw new BadRequestException(`Invalid permissions: ${invalid.join(", ")}`);
      }
    }

    const existing = await this.prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      throw new BadRequestException("Email already exists");
    }

    const passwordHash = await bcrypt.hash(body.password, 10);

    const user = await this.prisma.user.create({
      data: {
        email: body.email,
        displayName: body.displayName,
        passwordHash,
        role: body.role as any,
        permissions: body.permissions ? JSON.stringify(body.permissions) : null,
      },
    });

    await this.audit.log({
      operatorId: req.user.id,
      action: "CREATE_USER",
      targetType: "User",
      targetId: user.id,
      detail: { email: user.email, role: user.role },
    });

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      permissions: body.permissions ?? null,
      createdAt: user.createdAt,
    };
  }

  @Patch(":id")
  @Roles("SUPER_ADMIN")
  async updateUser(@Request() req: any, @Param("id") id: string, @Body() body: {
    displayName?: string;
    role?: string;
    permissions?: string[] | null;
  }) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) {
      throw new BadRequestException("User not found");
    }

    // Cannot change own role
    if (body.role && id === req.user.id) {
      throw new ForbiddenException("Cannot change your own role");
    }

    // Cannot demote another SUPER_ADMIN
    if (target.role === "SUPER_ADMIN" && body.role && body.role !== "SUPER_ADMIN") {
      const superAdminCount = await this.prisma.user.count({ where: { role: "SUPER_ADMIN" } });
      if (superAdminCount <= 1) {
        throw new ForbiddenException("Cannot demote the last super admin");
      }
    }

    if (body.role && !VALID_ROLES.includes(body.role)) {
      throw new BadRequestException(`Invalid role. Must be one of: ${VALID_ROLES.join(", ")}`);
    }

    if (body.permissions) {
      const invalid = body.permissions.filter((p) => !VALID_PERMISSIONS.includes(p));
      if (invalid.length > 0) {
        throw new BadRequestException(`Invalid permissions: ${invalid.join(", ")}`);
      }
    }

    const data: Record<string, any> = {};
    if (body.displayName !== undefined) data.displayName = body.displayName;
    if (body.role !== undefined) data.role = body.role;
    if (body.permissions !== undefined) {
      data.permissions = body.permissions === null ? null : JSON.stringify(body.permissions);
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data,
    });

    await this.audit.log({
      operatorId: req.user.id,
      action: "UPDATE_USER",
      targetType: "User",
      targetId: id,
      detail: { changes: body },
    });

    return {
      id: updated.id,
      email: updated.email,
      displayName: updated.displayName,
      role: updated.role,
      permissions: updated.permissions ? JSON.parse(updated.permissions) : null,
    };
  }

  @Patch(":id/reset-password")
  @Roles("SUPER_ADMIN")
  async resetPassword(@Request() req: any, @Param("id") id: string, @Body() body: { password: string }) {
    if (!body.password || body.password.length < 6) {
      throw new BadRequestException("Password must be at least 6 characters");
    }

    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) {
      throw new BadRequestException("User not found");
    }

    const passwordHash = await bcrypt.hash(body.password, 10);
    await this.prisma.user.update({ where: { id }, data: { passwordHash } });

    await this.audit.log({
      operatorId: req.user.id,
      action: "RESET_USER_PASSWORD",
      targetType: "User",
      targetId: id,
      detail: { targetEmail: target.email },
    });

    return { message: "Password reset successfully" };
  }

  @Delete(":id")
  @Roles("SUPER_ADMIN")
  async deleteUser(@Request() req: any, @Param("id") id: string) {
    if (id === req.user.id) {
      throw new ForbiddenException("Cannot delete yourself");
    }

    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) {
      throw new BadRequestException("User not found");
    }

    if (target.role === "SUPER_ADMIN") {
      const superAdminCount = await this.prisma.user.count({ where: { role: "SUPER_ADMIN" } });
      if (superAdminCount <= 1) {
        throw new ForbiddenException("Cannot delete the last super admin");
      }
    }

    await this.prisma.user.delete({ where: { id } });

    await this.audit.log({
      operatorId: req.user.id,
      action: "DELETE_USER",
      targetType: "User",
      targetId: id,
      detail: { deletedEmail: target.email, deletedRole: target.role },
    });

    return { message: "User deleted" };
  }
}
