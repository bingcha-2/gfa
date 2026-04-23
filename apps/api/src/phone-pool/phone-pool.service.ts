import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class PhonePoolService {
  constructor(private readonly prisma: PrismaService) {}

  /** List all phone numbers (admin view) */
  async listAll() {
    return this.prisma.phonePool.findMany({
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Sync phones from a client (upsert).
   * Creates new entries or updates existing ones.
   * Does NOT overwrite server-side status if already disabled.
   */
  async syncFromClient(
    phones: Array<{
      phoneNumber: string;
      countryCode?: string;
      smsUrl: string;
    }>,
    source?: string
  ) {
    const results: Array<{ phoneNumber: string; status: string }> = [];

    for (const phone of phones) {
      const existing = await this.prisma.phonePool.findUnique({
        where: { phoneNumber: phone.phoneNumber },
      });

      if (existing) {
        // Don't overwrite server status — just update smsUrl if needed
        if (existing.smsUrl !== phone.smsUrl) {
          await this.prisma.phonePool.update({
            where: { phoneNumber: phone.phoneNumber },
            data: { smsUrl: phone.smsUrl },
          });
        }
        results.push({
          phoneNumber: phone.phoneNumber,
          status: existing.status,
        });
      } else {
        const created = await this.prisma.phonePool.create({
          data: {
            phoneNumber: phone.phoneNumber,
            countryCode: phone.countryCode ?? "+1",
            smsUrl: phone.smsUrl,
            status: "available",
            source: source ?? "client",
          },
        });
        results.push({ phoneNumber: created.phoneNumber, status: created.status });
      }
    }

    return results;
  }

  /** Get status of a single phone number (client queries own numbers) */
  async getPhoneStatus(phoneNumber: string) {
    const phone = await this.prisma.phonePool.findUnique({
      where: { phoneNumber },
      select: { phoneNumber: true, status: true, disabledReason: true, usedCount: true },
    });
    return phone;
  }

  /** Mark a phone as disabled */
  async disablePhone(id: string, reason?: string) {
    return this.prisma.phonePool.update({
      where: { id },
      data: {
        status: "disabled",
        disabledReason: reason ?? "marked_disabled",
      },
    });
  }

  /** Mark phone as disabled by phone number (used by worker) */
  async disableByNumber(phoneNumber: string, reason?: string) {
    return this.prisma.phonePool.update({
      where: { phoneNumber },
      data: {
        status: "disabled",
        disabledReason: reason ?? "verification_failed",
      },
    });
  }

  /** Record usage of a phone number and mark it as used (no longer available) */
  async markUsed(phoneNumber: string, code?: string) {
    return this.prisma.phonePool.update({
      where: { phoneNumber },
      data: {
        status: "used",
        usedCount: { increment: 1 },
        lastUsedAt: new Date(),
        lastCode: code,
      },
    });
  }

  /** Delete a phone */
  async deletePhone(id: string) {
    return this.prisma.phonePool.delete({ where: { id } });
  }

  /** Bulk import (admin) */
  async bulkImport(
    lines: string[],
    source?: string
  ) {
    const phones = lines
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        // Format: phoneNumber|smsUrl  or  countryCode|phoneNumber|smsUrl
        const parts = line.split("|").map((p) => p.trim());
        if (parts.length === 2) {
          return { phoneNumber: parts[0], smsUrl: parts[1], countryCode: "+1" };
        } else if (parts.length >= 3) {
          return {
            countryCode: parts[0],
            phoneNumber: parts[1],
            smsUrl: parts[2],
          };
        }
        return null;
      })
      .filter(Boolean) as Array<{
        phoneNumber: string;
        smsUrl: string;
        countryCode: string;
      }>;

    return this.syncFromClient(phones, source ?? "admin");
  }
}
