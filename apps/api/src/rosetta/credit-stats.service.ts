import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { PrismaService } from "../prisma/prisma.service";
import { TokenServerService } from "../token-server/token-server.service";
import { beijingDayKey, beijingDayKeysSince, beijingDayStart } from "../common/beijing-time";

@Injectable()
export class CreditStatsService {
  private readonly logger = new Logger(CreditStatsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenServer: TokenServerService,
  ) {}

  // ── 30-minute credit snapshot cron ─────────────────────────────────────

  @Cron("*/30 * * * *")
  async snapshotCredits() {
    try {
      const status = this.tokenServer.getStatus();
      const accounts = status.quota?.accounts || [];

      const withCredits = accounts.filter(
        (a: any) => a.credits?.known && a.credits?.available && Number(a.credits.creditAmount || 0) >= 50,
      );
      const totalCredits = withCredits.reduce(
        (sum: number, a: any) => sum + Number(a.credits.creditAmount || 0),
        0,
      );

      await this.prisma.creditSnapshot.create({
        data: {
          totalCredits,
          accountCount: withCredits.length,
          totalAccounts: accounts.length,
          details: JSON.stringify(
            withCredits.map((a: any) => ({
              accountId: a.id,
              email: a.email,
              creditAmount: Number(a.credits.creditAmount || 0),
            })),
          ),
        },
      });

      this.logger.log(
        `Credit snapshot: ${totalCredits} credits across ${withCredits.length}/${accounts.length} accounts`,
      );
    } catch (err) {
      this.logger.error(`Credit snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── API: real-time stats + daily consumption ───────────────────────────

  async getCreditStats(days = 7) {
    const status = this.tokenServer.getStatus();
    const accounts = status.quota?.accounts || [];

    // Current real-time state
    const withCredits = accounts.filter(
      (a: any) => a.credits?.known && a.credits?.available && Number(a.credits.creditAmount || 0) >= 50,
    );
    const totalCredits = withCredits.reduce(
      (sum: number, a: any) => sum + Number(a.credits.creditAmount || 0),
      0,
    );

    // Daily consumption from CreditConsumption table (Beijing day buckets)
    const since = beijingDayStart(days);

    const consumptions = await this.prisma.creditConsumption.findMany({
      where: { timestamp: { gte: since } },
      select: { consumed: true, timestamp: true },
      orderBy: { timestamp: "asc" },
    });

    // Group by Beijing date
    const dailyMap = new Map<string, number>();
    for (const c of consumptions) {
      const dateKey = beijingDayKey(c.timestamp);
      dailyMap.set(dateKey, (dailyMap.get(dateKey) || 0) + c.consumed);
    }

    // Fill all days (including zeros)
    const dailyConsumption = beijingDayKeysSince(days).map((dateKey) => ({
      date: dateKey,
      consumed: Math.round((dailyMap.get(dateKey) || 0) * 100) / 100,
    }));

    // Today's total (Beijing day)
    const todayKey = beijingDayKey(new Date());
    const todayConsumed = Math.round((dailyMap.get(todayKey) || 0) * 100) / 100;

    return {
      current: {
        totalCredits: Math.round(totalCredits * 100) / 100,
        accountsWithCredits: withCredits.length,
        totalAccounts: accounts.length,
      },
      today: {
        consumed: todayConsumed,
        events: consumptions.filter((c) => beijingDayKey(c.timestamp) === todayKey).length,
      },
      dailyConsumption,
    };
  }

  // ── API: paginated consumption records ─────────────────────────────────

  async getConsumptionRecords(opts: {
    page?: number;
    pageSize?: number;
    search?: string;
    days?: number;
  }) {
    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize || 30));
    const days = opts.days || 7;
    const search = (opts.search || "").trim();

    const since = beijingDayStart(days);

    const where: any = { timestamp: { gte: since } };
    if (search) {
      where.OR = [
        { email: { contains: search } },
        { accessKeyId: { contains: search } },
        { accessKeyName: { contains: search } },
      ];
    }

    const [records, total] = await Promise.all([
      this.prisma.creditConsumption.findMany({
        where,
        orderBy: { timestamp: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.creditConsumption.count({ where }),
    ]);

    return {
      records: records.map((r: any) => ({
        id: r.id,
        accountId: r.accountId,
        email: r.email,
        oldAmount: Math.round(r.oldAmount * 100) / 100,
        newAmount: Math.round(r.newAmount * 100) / 100,
        consumed: Math.round(r.consumed * 100) / 100,
        accessKeyId: r.accessKeyId || null,
        accessKeyName: r.accessKeyName || null,
        timestamp: r.timestamp.toISOString(),
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  // ── API: balance trend snapshots ───────────────────────────────────────

  async getCreditSnapshots(days = 7) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const snapshots = await this.prisma.creditSnapshot.findMany({
      where: { timestamp: { gte: since } },
      select: {
        timestamp: true,
        totalCredits: true,
        accountCount: true,
        totalAccounts: true,
      },
      orderBy: { timestamp: "asc" },
    });

    return { snapshots };
  }

  // ── Cleanup: retain only 90 days of data ───────────────────────────────

  @Cron("0 3 * * *") // 3 AM daily
  async cleanupOldData() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);

    try {
      const [snapshots, consumptions] = await Promise.all([
        this.prisma.creditSnapshot.deleteMany({ where: { timestamp: { lt: cutoff } } }),
        this.prisma.creditConsumption.deleteMany({ where: { timestamp: { lt: cutoff } } }),
      ]);

      if (snapshots.count > 0 || consumptions.count > 0) {
        this.logger.log(
          `Cleaned up ${snapshots.count} snapshots + ${consumptions.count} consumption records older than 90 days`,
        );
      }
    } catch (err) {
      this.logger.error(`Credit data cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
