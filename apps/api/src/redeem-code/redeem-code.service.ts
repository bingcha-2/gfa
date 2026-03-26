import { Injectable, NotFoundException } from "@nestjs/common";
import { randomInt } from "node:crypto";
import { RedeemCodeType } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class RedeemCodeService {
  constructor(private readonly prisma: PrismaService) {}

  private generateCode(length = 16) {
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("");
  }

  async findAll(status?: string) {
    const where = status ? { status: status as any } : {};

    return this.prisma.redeemCode.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        order: {
          select: { id: true, orderNo: true, userEmail: true, status: true }
        }
      }
    });
  }

  async batchCreate(params: {
    count: number;
    product?: string;
    codeType?: string;
    createdById?: string;
  }) {
    const seenCodes = new Set<string>();
    const dataList = Array.from({ length: params.count }, () => {
      let code = this.generateCode();

      while (seenCodes.has(code)) {
        code = this.generateCode();
      }

      seenCodes.add(code);

      return {
        code,
        product: params.product ?? "GOOGLE_ONE",
        codeType: (params.codeType as RedeemCodeType) ?? RedeemCodeType.JOIN_GROUP,
        createdById: params.createdById
      };
    });

    // Use transaction for atomicity
    return this.prisma.$transaction(
      dataList.map((data) => this.prisma.redeemCode.create({ data }))
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

  async verifyAndReserve(codeStr: string) {
    const normalizedCode = codeStr.trim().toUpperCase();

    // Use interactive transaction to prevent race conditions
    return this.prisma.$transaction(async (tx) => {
      const code = await tx.redeemCode.findUnique({
        where: { code: normalizedCode }
      });

      if (!code) return null;
      if (code.status !== "UNUSED") return null;

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
