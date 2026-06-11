import { Injectable } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async log(params: {
    operatorId?: string;
    action: string;
    targetType: string;
    targetId: string;
    detail?: Record<string, unknown>;
  }) {
    return this.prisma.auditLog.create({
      data: {
        operatorId: params.operatorId,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        detail: params.detail ? JSON.stringify(params.detail) : undefined
      }
    });
  }

  async findAll(params?: {
    operatorId?: string;
    targetType?: string;
    skip?: number;
    take?: number;
  }) {
    const where: Record<string, unknown> = {};

    if (params?.operatorId) where.operatorId = params.operatorId;
    if (params?.targetType) where.targetType = params.targetType;

    return this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: params?.skip ?? 0,
      take: params?.take ?? 50,
      include: {
        operator: {
          select: { id: true, email: true, displayName: true }
        }
      }
    });
  }
}
