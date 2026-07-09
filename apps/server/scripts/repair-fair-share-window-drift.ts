/**
 * Repair FairShareWindow rows damaged by resetAt/windowStart drift handling.
 *
 * Default mode is dry-run. Use --apply to write changes.
 *
 * What it repairs:
 * 1) Shared/oversold cards that were incorrectly attributed with the whole account drop
 *    during a backward windowStart correction. These rows show account quota still healthy
 *    (lastFraction >= --healthy-min) but attributedShare already >= the card's share.
 *    For those, clear attributedShare/weightedUsed only; keep lastFraction/windowStart.
 *
 * 2) Full-account exclusive single-participant rows that are stale compared with the
 *    latest AccountQuotaSnapshot. For those, the full account drop is unambiguous, so
 *    align windowStart/lastFraction and set attributedShare to at least 1 - fraction.
 */

import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

import { bucketKey } from "../src/leasing/lease-core/product-bucket";

const WEEKLY_SUFFIX = "::weekly";
const WINDOW_MS = 5 * 60 * 60 * 1000;
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const projectRoot = resolve(__dirname, "../../..");

type SubscriptionLike = {
  id: string;
  weight: number | null;
  config: string | null;
};

type FairShareRow = {
  provider: string;
  accountId: number;
  bucket: string;
  cardId: string;
  windowStart: bigint;
  weightedUsed: number;
  attributedShare: number;
  lockedDenominator: number;
  lastFraction: number;
  isParticipant: boolean;
};

type LatestSnapshot = {
  provider: string;
  accountId: number;
  modelKey: string;
  hourlyPercent: number | null;
  weeklyPercent: number | null;
  hourlyResetAt: Date | null;
  weeklyResetAt: Date | null;
  timestamp: Date;
};

function resolveDatabaseUrl(): string {
  const rawUrl = process.env.DATABASE_URL ?? "file:./dev.db";
  if (!rawUrl.startsWith("file:")) return rawUrl;
  const rawPath = rawUrl.slice("file:".length);
  if (!rawPath || /^[A-Za-z]:/.test(rawPath) || rawPath.startsWith("/")) return rawUrl;
  return `file:${resolve(projectRoot, "prisma", rawPath).replace(/\\/g, "/")}`;
}

function dbPathFromUrl(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith("file:")) return null;
  return databaseUrl.slice("file:".length);
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function numArg(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseConfig(config: string | null): Record<string, unknown> {
  if (!config) return {};
  try {
    const parsed = JSON.parse(config);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isExclusive(sub: SubscriptionLike | undefined): boolean {
  return parseConfig(sub?.config ?? null).exclusive === true;
}

function shareOf(row: FairShareRow, sub: SubscriptionLike | undefined): number {
  const d = Number(row.lockedDenominator) || 0;
  if (d <= 0) return 0;
  const w = Math.max(0, Number(sub?.weight ?? 1) || 0);
  return Math.min(1, w / d);
}

function snapshotFraction(snapshot: LatestSnapshot, weekly: boolean): number | null {
  const pct = weekly ? snapshot.weeklyPercent : snapshot.hourlyPercent;
  if (pct == null) return null;
  const n = Number(pct);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.max(0, Math.min(1, n / 100));
}

function snapshotResetAt(snapshot: LatestSnapshot, weekly: boolean): number {
  const d = weekly ? snapshot.weeklyResetAt : snapshot.hourlyResetAt;
  const ms = d instanceof Date ? d.getTime() : 0;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function coversWindow(resetAt: number, windowStart: number, windowMs: number): boolean {
  if (!(resetAt > 0)) return false;
  const snapStart = resetAt - windowMs;
  return snapStart + windowMs > windowStart + 60_000;
}

function latestKey(provider: string, accountId: number, bucket: string): string {
  return `${provider}\u0000${accountId}\u0000${bucket}`;
}

function bucketBase(bucket: string): string {
  return bucket.endsWith(WEEKLY_SUFFIX) ? bucket.slice(0, -WEEKLY_SUFFIX.length) : bucket;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const noBackup = process.argv.includes("--no-backup");
  const providerFilter = argValue("provider");
  const healthyMin = numArg("healthy-min", 0.5);
  const resetDriftMs = numArg("reset-drift-ms", 60_000);
  const databaseUrl = resolveDatabaseUrl();

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const providerWhere = providerFilter ? { provider: providerFilter } : {};
    const [rows, subs, snapshots] = await Promise.all([
      prisma.fairShareWindow.findMany({ where: providerWhere }) as Promise<FairShareRow[]>,
      prisma.subscription.findMany({
        select: { id: true, weight: true, config: true },
      }) as Promise<SubscriptionLike[]>,
      prisma.accountQuotaSnapshot.findMany({
        where: providerWhere,
        orderBy: { timestamp: "desc" },
      }) as Promise<LatestSnapshot[]>,
    ]);

    const subById = new Map(subs.map((s) => [s.id, s]));

    const participantCount = new Map<string, number>();
    for (const r of rows) {
      if (!r.isParticipant) continue;
      const key = `${r.provider}\u0000${r.accountId}\u0000${r.bucket}`;
      participantCount.set(key, (participantCount.get(key) || 0) + 1);
    }

    const latest = new Map<string, LatestSnapshot>();
    for (const s of snapshots) {
      const base = bucketKey(s.provider, s.modelKey);
      const keys = [
        latestKey(s.provider, s.accountId, base),
        latestKey(s.provider, s.accountId, `${base}${WEEKLY_SUFFIX}`),
      ];
      for (const key of keys) {
        if (!latest.has(key)) latest.set(key, s);
      }
    }

    const sharedOverAttributed: FairShareRow[] = [];
    const fullExclusiveStale: Array<{ row: FairShareRow; fraction: number; windowStart: number; attributedShare: number }> = [];

    for (const row of rows) {
      const sub = subById.get(row.cardId);
      const share = shareOf(row, sub);
      const pKey = `${row.provider}\u0000${row.accountId}\u0000${row.bucket}`;
      const pCount = participantCount.get(pKey) || 0;
      const fullExclusiveSingle = pCount === 1 && isExclusive(sub) && share >= 1;

      if (
        !fullExclusiveSingle &&
        Number(row.lockedDenominator) > 0 &&
        Number(row.lastFraction) >= healthyMin &&
        Number(row.attributedShare) >= share &&
        share > 0
      ) {
        sharedOverAttributed.push(row);
      }

      if (fullExclusiveSingle) {
        const snap = latest.get(latestKey(row.provider, row.accountId, row.bucket));
        if (!snap) continue;
        const weekly = row.bucket.endsWith(WEEKLY_SUFFIX);
        const fraction = snapshotFraction(snap, weekly);
        const resetAt = snapshotResetAt(snap, weekly);
        const windowMs = weekly ? WEEKLY_WINDOW_MS : WINDOW_MS;
        if (fraction == null || !coversWindow(resetAt, Number(row.windowStart), windowMs)) continue;
        if (fraction >= Number(row.lastFraction) - 1e-9) continue;
        const snapStart = resetAt - windowMs;
        fullExclusiveStale.push({
          row,
          fraction,
          windowStart: snapStart,
          attributedShare: Math.max(Number(row.attributedShare) || 0, 1 - fraction),
        });
      }
    }

    console.log("=== repair-fair-share-window-drift ===");
    console.log(`mode:                 ${apply ? "APPLY" : "dry-run"}`);
    console.log(`provider:             ${providerFilter ?? "(all)"}`);
    console.log(`rows scanned:          ${rows.length}`);
    console.log(`shared over-attributed:${sharedOverAttributed.length}`);
    console.log(`full exclusive stale:  ${fullExclusiveStale.length}`);

    const preview = <T>(title: string, items: T[], format: (item: T) => string) => {
      console.log(`\n${title}`);
      for (const item of items.slice(0, 30)) console.log(`  ${format(item)}`);
      if (items.length > 30) console.log(`  ... ${items.length - 30} more`);
    };

    preview("shared over-attributed candidates", sharedOverAttributed, (r) =>
      `${r.provider} acc=${r.accountId} bucket=${r.bucket} card=${r.cardId} last=${r.lastFraction} T=${r.attributedShare} D=${r.lockedDenominator}`,
    );
    preview("full exclusive stale candidates", fullExclusiveStale, ({ row, fraction, attributedShare }) =>
      `${row.provider} acc=${row.accountId} bucket=${row.bucket} card=${row.cardId} ${row.lastFraction}->${fraction} T=>${attributedShare}`,
    );

    if (!apply) {
      console.log("\ndry-run only. Re-run with --apply to write changes.");
      return;
    }

    const dbPath = dbPathFromUrl(databaseUrl);
    if (dbPath && !noBackup && existsSync(dbPath)) {
      const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
      const backup = resolve(projectRoot, "backups", `dev-fair-share-repair-${stamp}.db`);
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(dbPath, backup);
      console.log(`\nbackup: ${backup}`);
    }

    let cleared = 0;
    let aligned = 0;
    await prisma.$transaction(async (tx) => {
      for (const row of sharedOverAttributed) {
        await tx.fairShareWindow.update({
          where: {
            provider_accountId_bucket_cardId: {
              provider: row.provider,
              accountId: row.accountId,
              bucket: row.bucket,
              cardId: row.cardId,
            },
          },
          data: {
            attributedShare: 0,
            weightedUsed: 0,
            updatedAt: new Date(),
          },
        });
        cleared += 1;
      }

      for (const item of fullExclusiveStale) {
        const row = item.row;
        await tx.fairShareWindow.update({
          where: {
            provider_accountId_bucket_cardId: {
              provider: row.provider,
              accountId: row.accountId,
              bucket: row.bucket,
              cardId: row.cardId,
            },
          },
          data: {
            windowStart: BigInt(Math.trunc(item.windowStart)),
            lastFraction: item.fraction,
            attributedShare: item.attributedShare,
            weightedUsed: 0,
            updatedAt: new Date(),
          },
        });
        aligned += 1;
      }
    });

    console.log(`\ncleared shared rows: ${cleared}`);
    console.log(`aligned exclusive rows: ${aligned}`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
