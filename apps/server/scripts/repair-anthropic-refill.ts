import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

import { rowToConfig } from "../src/leasing/subscription/subscription-config";
import { nextUtcHour, repairAnthropicWeeklyWindow } from "../src/leasing/quota/anthropic-refill-repair";

const projectRoot = resolve(__dirname, "../../..");

function resolveDatabaseUrl(): string {
  const rawUrl = process.env.DATABASE_URL ?? "file:./dev.db";
  if (!rawUrl.startsWith("file:")) return rawUrl;
  const rawPath = rawUrl.slice("file:".length);
  if (!rawPath || /^[A-Za-z]:/.test(rawPath) || rawPath.startsWith("/")) return rawUrl;
  return `file:${resolve(projectRoot, "prisma", rawPath).replace(/\\/g, "/")}`;
}

function valueAfter(argv: string[], name: string): string {
  const equals = argv.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || "") : "";
}

function usage(): never {
  throw new Error(
    "usage: pnpm --dir apps/server quota:repair-anthropic-refill"
    + " [--account-id 43] (--list-snapshots [--since-hours 48]"
    + " | --reset-at 2026-07-16T03:12:34.000Z [--apply --service-stopped])",
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const requestedAccountId = Number(valueAfter(argv, "--account-id"));
  const accountId = requestedAccountId > 0 ? requestedAccountId : undefined;
  const listSnapshots = argv.includes("--list-snapshots");
  const sinceHours = Math.max(1, Number(valueAfter(argv, "--since-hours") || 48));
  const resetObservedAt = Date.parse(valueAfter(argv, "--reset-at"));
  const apply = argv.includes("--apply");
  const serviceStopped = argv.includes("--service-stopped");
  if (!listSnapshots && !Number.isFinite(resetObservedAt)) usage();
  if (listSnapshots && apply) throw new Error("LIST_SNAPSHOTS_IS_READ_ONLY");
  if (resetObservedAt > Date.now()) throw new Error("RESET_AT_IS_IN_THE_FUTURE");
  if (apply && !serviceStopped) {
    throw new Error("REFUSING_APPLY: stop GFA first, then pass --service-stopped");
  }

  const prisma = new PrismaClient({ datasourceUrl: resolveDatabaseUrl() });
  try {
    if (listSnapshots) {
      const snapshots = await prisma.accountQuotaSnapshot.findMany({
        where: {
          provider: "anthropic",
          ...(accountId ? { accountId } : {}),
          timestamp: { gte: new Date(Date.now() - sinceHours * 3_600_000) },
        },
        orderBy: { timestamp: "asc" },
        select: {
          accountId: true,
          email: true,
          timestamp: true,
          hourlyPercent: true,
          weeklyPercent: true,
          hourlyResetAt: true,
          weeklyResetAt: true,
        },
      });
      console.log(`mode=LIST_SNAPSHOTS accountId=${accountId || "ALL"} sinceHours=${sinceHours} rows=${snapshots.length}`);
      for (const snapshot of snapshots) {
        console.log(JSON.stringify({
          accountId: snapshot.accountId,
          email: snapshot.email,
          timestamp: snapshot.timestamp.toISOString(),
          hourlyPercent: snapshot.hourlyPercent,
          weeklyPercent: snapshot.weeklyPercent,
          hourlyResetAt: snapshot.hourlyResetAt?.toISOString() || null,
          weeklyResetAt: snapshot.weeklyResetAt?.toISOString() || null,
        }));
      }
      return;
    }

    const replayFrom = nextUtcHour(resetObservedAt);
    const subscriptions = await prisma.subscription.findMany({
      where: { status: "ACTIVE" },
      select: {
        id: true,
        customerId: true,
        updatedAt: true,
        windowState: true,
        config: true,
        productEntitlements: true,
        bucketLimits: true,
        bindings: true,
        levels: true,
        weight: true,
        deviceLimit: true,
        weeklyTokenLimit: true,
        windowMs: true,
        customer: { select: { email: true } },
      },
    });
    const candidates = subscriptions.flatMap((subscription) => {
      const config = rowToConfig(subscription);
      const boundAccountId = Number((config.bindings as Record<string, unknown> | undefined)?.anthropic || 0);
      if (!(boundAccountId > 0) || (accountId && boundAccountId !== accountId)) return [];
      return [{ subscription, accountId: boundAccountId }];
    });
    const ids = candidates.map((candidate) => candidate.subscription.id);
    const hourly = ids.length === 0 ? [] : await prisma.cardUsageHourly.groupBy({
      by: ["accessKeyId"],
      where: {
        accessKeyId: { in: ids },
        hourStart: { gte: new Date(replayFrom) },
        OR: [
          { bucket: { startsWith: "anthropic-" } },
          { modelKey: { startsWith: "claude" } },
        ],
      },
      _sum: { apiValueUsd: true },
    });
    const rebuiltById = new Map(hourly.map((row) => [
      row.accessKeyId,
      Math.max(0, Number(row._sum.apiValueUsd) || 0),
    ]));
    const repairs = candidates.map((candidate) => ({
      ...candidate,
      repair: repairAnthropicWeeklyWindow({
        rawWindowState: candidate.subscription.windowState,
        accountId: candidate.accountId,
        resetObservedAt,
        rebuiltUsedWeekly: rebuiltById.get(candidate.subscription.id) || 0,
      }),
    }));

    const affectedAccounts = new Set(repairs.map((repair) => repair.accountId));
    console.log(
      `mode=${apply ? "APPLY" : "DRY_RUN"} accountId=${accountId || "ALL"}`
      + ` accounts=${affectedAccounts.size} subscriptions=${repairs.length}`,
    );
    console.log(`resetAt=${new Date(resetObservedAt).toISOString()} replayFrom=${new Date(replayFrom).toISOString()}`);
    if (replayFrom !== resetObservedAt) {
      console.log("warning=partial reset hour is excluded because CardUsageHourly has hourly granularity");
    }
    for (const { subscription, accountId: boundAccountId, repair } of repairs) {
      console.log(
        `READY account=${boundAccountId} subscription=${subscription.id} customer=${subscription.customer.email}`
        + ` weeklyUsd=${repair.oldUsedWeekly.toFixed(6)}->${repair.newUsedWeekly.toFixed(6)}`,
      );
    }
    if (!apply || repairs.length === 0) return;

    const backupDir = resolve(projectRoot, "backups");
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = resolve(backupDir, `anthropic-refill-${accountId || "all"}-${stamp}.json`);
    writeFileSync(backupPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      accountId: accountId || "ALL",
      resetObservedAt: new Date(resetObservedAt).toISOString(),
      replayFrom: new Date(replayFrom).toISOString(),
      subscriptions: repairs.map(({ subscription, accountId: boundAccountId }) => ({
        accountId: boundAccountId,
        id: subscription.id,
        customerId: subscription.customerId,
        customerEmail: subscription.customer.email,
        updatedAt: subscription.updatedAt.toISOString(),
        windowState: subscription.windowState,
      })),
    }, null, 2));

    await prisma.$transaction(async (tx) => {
      for (const { subscription, repair } of repairs) {
        const updated = await tx.subscription.updateMany({
          where: { id: subscription.id, updatedAt: subscription.updatedAt },
          data: { windowState: repair.windowState },
        });
        if (updated.count !== 1) throw new Error(`STALE_SUBSCRIPTION:${subscription.id}`);
      }
    });
    console.log(`APPLIED subscriptions=${repairs.length} backup=${backupPath}`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
