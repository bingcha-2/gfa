import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { PrismaService } from "../prisma/prisma.service";
import { TokenServerService } from "../token-server/token-server.service";

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

    // Daily consumption from CreditConsumption table
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const consumptions = await this.prisma.creditConsumption.findMany({
      where: { timestamp: { gte: since } },
      select: { consumed: true, timestamp: true },
      orderBy: { timestamp: "asc" },
    });

    // Group by date
    const dailyMap = new Map<string, number>();
    for (const c of consumptions) {
      const dateKey = c.timestamp.toISOString().slice(0, 10);
      dailyMap.set(dateKey, (dailyMap.get(dateKey) || 0) + c.consumed);
    }

    // Fill all days (including zeros)
    const dailyConsumption: { date: string; consumed: number }[] = [];
    const cursor = new Date(since);
    const today = new Date();
    while (cursor <= today) {
      const dateKey = cursor.toISOString().slice(0, 10);
      dailyConsumption.push({
        date: dateKey,
        consumed: Math.round((dailyMap.get(dateKey) || 0) * 100) / 100,
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    // Today's total
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayConsumed = Math.round((dailyMap.get(todayKey) || 0) * 100) / 100;

    return {
      current: {
        totalCredits: Math.round(totalCredits * 100) / 100,
        accountsWithCredits: withCredits.length,
        totalAccounts: accounts.length,
      },
      today: {
        consumed: todayConsumed,
        events: consumptions.filter(
          (c) => c.timestamp.toISOString().slice(0, 10) === todayKey,
        ).length,
      },
      dailyConsumption,
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
