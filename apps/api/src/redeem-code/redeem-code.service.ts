import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomInt } from "node:crypto";
import { RedeemCodeType } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

/** Prefix map: each code type gets a recognisable prefix */
const CODE_PREFIX: Record<RedeemCodeType, string> = {
  JOIN_GROUP: "JZ",
  ACCOUNT_SWAP: "HH",
  SUBSCRIPTION: "CX",
};

@Injectable()
export class RedeemCodeService {
  constructor(private readonly prisma: PrismaService) { }

  private generateCode(codeType: RedeemCodeType, length = 16) {
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const body = Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("");
    const prefix = CODE_PREFIX[codeType] ?? "";
    return prefix ? `${prefix}-${body}` : body;
  }

  async findAll(page = 1, pageSize = 30, status?: string, codeType?: string, skipStats = false, search?: string) {
    const where: any = {};
    if (status && status !== 'ALL') where.status = status;
    if (codeType && codeType !== 'ALL') where.codeType = codeType;

    // Search by code or associated order userEmail
    if (search) {
      where.OR = [
        { code: { contains: search, mode: "insensitive" } },
        { order: { userEmail: { contains: search, mode: "insensitive" } } },
        { order: { orderNo: { contains: search, mode: "insensitive" } } }
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.redeemCode.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          order: {
            select: { id: true, orderNo: true, userEmail: true, status: true }
          }
        }
      }),
      this.prisma.redeemCode.count({ where })
    ]);

    // When searching, skip global stats to keep query fast
    if (skipStats || search) {
      return { items, total, stats: null };
    }

    const [totalUnused, countJoin, countSwap, countSub, totalAll] = await Promise.all([
      this.prisma.redeemCode.count({ where: { status: "UNUSED" } }),
      this.prisma.redeemCode.count({ where: { codeType: "JOIN_GROUP" } }),
      this.prisma.redeemCode.count({ where: { codeType: "ACCOUNT_SWAP" } }),
      this.prisma.redeemCode.count({ where: { codeType: "SUBSCRIPTION" } }),
      this.prisma.redeemCode.count()
    ]);

    return { 
      items, 
      total, 
      stats: {
        unused: totalUnused,
        types: {
          JOIN_GROUP: countJoin,
          ACCOUNT_SWAP: countSwap,
          SUBSCRIPTION: countSub,
          ALL: totalAll
        }
      }
    };
  }

  async batchCreate(params: {
    count: number;
    product?: string;
    codeType?: string;
    createdById?: string;
    /** SUBSCRIPTION only: validity period (days) */
    validDays?: number;
    /** SUBSCRIPTION only: max swaps per window */
    swapLimit?: number;
    /** SUBSCRIPTION only: rolling window in hours */
    swapWindowHours?: number;
  }) {
    const codeType = (params.codeType as RedeemCodeType) ?? RedeemCodeType.JOIN_GROUP;
    const seenCodes = new Set<string>();
    const dataList = Array.from({ length: params.count }, () => {
      let code = this.generateCode(codeType);

      while (seenCodes.has(code)) {
        code = this.generateCode(codeType);
      }

      seenCodes.add(code);

      const base: Record<string, any> = {
        code,
        product: params.product ?? "GOOGLE_ONE",
        codeType,
        createdById: params.createdById
      };

      // SUBSCRIPTION codes carry validity + swap config
      if (codeType === RedeemCodeType.SUBSCRIPTION) {
        const validDays = params.validDays ?? 30;
        // S-05: Enforce swap rate-limit bounds to prevent misconfiguration
        const swapLimit = Math.min(Math.max(params.swapLimit ?? 2, 1), 10);
        const swapWindowHours = Math.max(params.swapWindowHours ?? 5, 1);
        base.validDays = validDays;
        base.swapLimit = swapLimit;
        base.swapWindowHours = swapWindowHours;
        // Pre-compute expiresAt so it's visible in the admin panel
        base.expiresAt = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000);
      }

      return base;
    });

    // Use transaction for atomicity
    return this.prisma.$transaction(
      dataList.map((data) => this.prisma.redeemCode.create({ data: data as any }))
    );
  }

  async disable(id: string) {
    const code = await this.prisma.redeemCode.findUnique({ where: { id } });

    if (!code) throw new NotFoundException("Redeem code not found");

    return this.prisma.redeemCode.update({
      where: { id },
      data: { status: "DISABLED" }
    });
  }

  async remove(id: string) {
    const code = await this.prisma.redeemCode.findUnique({ where: { id } });

    if (!code) throw new NotFoundException("Redeem code not found");

    // Allow deletion of any status — Order.redeemCodeId uses onDelete:SetNull
    await this.prisma.redeemCode.delete({ where: { id } });
    return { id, code: code.code, deleted: true };
  }

  async verifyAndReserve(codeStr: string) {
    const normalizedCode = codeStr.trim().toUpperCase();

    // Use interactive transaction to prevent race conditions
    return this.prisma.$transaction(async (tx) => {
      const code = await tx.redeemCode.findUnique({
        where: { code: normalizedCode }
      });

      if (!code) return null;
      if (code.status !== "UNUSED") return null;

      // Check expiry (SUBSCRIPTION codes have expiresAt set at generation)
      if (code.expiresAt && code.expiresAt < new Date()) return null;

      await tx.redeemCode.update({
        where: { id: code.id },
        data: { status: "RESERVED" }
      });

      return code;
    });
  }

  async markUsed(id: string) {
    return this.prisma.redeemCode.updateMany({
      where: {
        id,
        status: { not: "USED" }
      },
      data: {
        status: "USED",
        usedAt: new Date()
      }
    });
  }
}
