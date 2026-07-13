import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

import { FairShareWindowRepository } from "../src/leasing/quota/fair-share-window-repository";
import {
  checkPersistedUsageCoverage,
  isRepairLogInBucket,
  parsePersistedUsageEvents,
  parseExportUtc,
  parseRepairArgs,
  parseRepairExport,
  reconstructMissedWeeklyReset,
  type RepairSnapshot,
} from "../src/leasing/quota/missed-weekly-reset-repair";

const projectRoot = resolve(__dirname, "../../..");

function resolveDatabaseUrl(): string {
  const rawUrl = process.env.DATABASE_URL ?? "file:./dev.db";
  if (!rawUrl.startsWith("file:")) return rawUrl;
  const rawPath = rawUrl.slice("file:".length);
  if (!rawPath || /^[A-Za-z]:/.test(rawPath) || rawPath.startsWith("/")) return rawUrl;
  return `file:${resolve(projectRoot, "prisma", rawPath).replace(/\\/g, "/")}`;
}

function resolveInputPath(value: string): string {
  if (isAbsolute(value)) return value;
  const fromCwd = resolve(process.cwd(), value);
  if (existsSync(fromCwd)) return fromCwd;
  return resolve(projectRoot, value);
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

async function main(): Promise<void> {
  const args = parseRepairArgs(process.argv.slice(2));
  const inputPath = resolveInputPath(args.inputPath);
  const candidates = parseRepairExport(JSON.parse(readFileSync(inputPath, "utf8")));
  const prisma = new PrismaClient({ datasourceUrl: resolveDatabaseUrl() });
  const repository = new FairShareWindowRepository(prisma, "codex");
  let rejected = 0;
  let ready = 0;
  let applied = 0;

  console.log(`mode=${args.apply ? "APPLY" : "DRY_RUN"} candidates=${candidates.length} input=${inputPath}`);
  try {
    for (const candidate of candidates) {
      const label = `account=${candidate.accountId} bucket=${candidate.bucket}`;
      try {
        const loaded = await repository.loadAccount(candidate.accountId, candidate.bucket);
        if (!loaded.ok) {
          console.log(`SKIP ${label} reason=${loaded.reason}`);
          continue;
        }
        const currentRevision = loaded.windows.weekly.revision;
        const missedResetAt = parseExportUtc(candidate.missedResetObservedUtc);
        const snapshotRows = await prisma.accountQuotaSnapshot.findMany({
          where: {
            provider: "codex",
            accountId: candidate.accountId,
            timestamp: { gte: new Date(missedResetAt - 60_000) },
            weeklyPercent: { not: null },
            weeklyResetAt: { not: null },
          },
          orderBy: { timestamp: "asc" },
          select: { id: true, timestamp: true, weeklyPercent: true, weeklyResetAt: true },
        });
        const snapshots: RepairSnapshot[] = snapshotRows.map((row) => ({
          id: row.id,
          observedAt: row.timestamp.getTime(),
          fraction: Number(row.weeklyPercent) / 100,
          resetAt: row.weeklyResetAt!.getTime(),
        }));

        const subjectIds = Object.keys(loaded.windows.weekly.subjects);
        const subscriptions = await prisma.subscription.findMany({
          where: { id: { in: subjectIds } },
          select: { id: true, windowState: true },
        });
        const byId = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
        const missing = subjectIds.filter((subjectId) => !byId.has(subjectId));
        if (missing.length > 0) {
          rejected++;
          console.log(`REJECT ${label} reason=SUBSCRIPTION_MISSING subjects=${missing.join(",")}`);
          continue;
        }
        const persistedUsageEvents = subjectIds.flatMap((quotaSubjectId) => parsePersistedUsageEvents({
          quotaSubjectId,
          bucket: candidate.bucket,
          missedResetAt,
          windowState: byId.get(quotaSubjectId)!.windowState,
        }));
        const requestLogs = await prisma.requestLog.findMany({
          where: {
            provider: "codex",
            accountId: candidate.accountId,
            quotaSubjectId: { in: subjectIds },
            at: { gte: new Date(missedResetAt - 60_000) },
          },
          orderBy: [{ at: "asc" }, { id: "asc" }],
          select: {
            id: true,
            quotaSubjectId: true,
            at: true,
            upstreamCompletedAt: true,
            modelKey: true,
            reportId: true,
            totalTokens: true,
            requestStartedAt: true,
            snapshotObservedAt: true,
          },
        });
        const coverage = checkPersistedUsageCoverage(
          persistedUsageEvents,
          requestLogs.filter((row) => isRepairLogInBucket("codex", candidate.bucket, row.modelKey)).map((row) => ({
            id: row.id,
            quotaSubjectId: row.quotaSubjectId,
            at: row.at.getTime(),
            requestStartedAt: Number(row.requestStartedAt),
            upstreamCompletedAt: Number(row.upstreamCompletedAt),
            modelId: row.modelKey,
            reportId: row.reportId,
            totalTokens: Number(row.totalTokens),
          })),
          missedResetAt + 60_000,
        );
        if (!coverage.ok) {
          rejected++;
          console.log(`REJECT ${label} reason=${coverage.reason} groups=${coverage.groups.length}`);
          for (const group of coverage.groups) {
            console.log(
              `  COVERAGE subject=${group.quotaSubjectId} model=${group.modelId}`
              + ` events=${group.events} logs=${group.logs}`,
            );
          }
          continue;
        }
        const usageEvents = persistedUsageEvents;
        const result = reconstructMissedWeeklyReset({
          candidate,
          current: loaded.windows,
          snapshots,
          usageEvents,
        });
        if (!result.ok) {
          if (result.reason === "ALREADY_CLEAN") {
            console.log(`SKIP ${label} reason=${result.reason}`);
          } else {
            rejected++;
            console.log(`REJECT ${label} reason=${result.reason}`);
          }
          continue;
        }

        const oldBurn = sum(Object.values(loaded.windows.weekly.subjects)
          .map((subject) => subject.carriedAttributedShare + subject.attributedShare))
          + loaded.windows.weekly.unattributedShare;
        const newBurn = sum(Object.values(result.windows.weekly.subjects)
          .map((subject) => subject.carriedAttributedShare + subject.attributedShare))
          + result.windows.weekly.unattributedShare;
        ready++;
        console.log(
          `READY ${label} revision=${currentRevision}->${result.windows.weekly.revision}`
          + ` fraction=${result.windows.weekly.fraction.toFixed(6)}`
          + ` burn=${oldBurn.toFixed(6)}->${newBurn.toFixed(6)}`
          + ` cu=${result.stats.oldCu.toFixed(6)}->${result.stats.reconstructedCu.toFixed(6)}`
          + ` events=${result.stats.usageEvents}`,
        );
        if (!args.apply) continue;

        const latest = await repository.loadAccount(candidate.accountId, candidate.bucket);
        if (!latest.ok || latest.windows.weekly.revision !== currentRevision) {
          rejected++;
          console.log(`REJECT ${label} reason=STALE_REVISION`);
          continue;
        }
        await repository.checkpointAccount(candidate.accountId, candidate.bucket, result.windows);
        applied++;
        console.log(`APPLIED ${label} revision=${result.windows.weekly.revision}`);
      } catch (error) {
        rejected++;
        console.log(`REJECT ${label} reason=${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  console.log(`summary ready=${ready} applied=${applied} rejected=${rejected}`);
  if (rejected > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
