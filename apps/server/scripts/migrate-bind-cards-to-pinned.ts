/**
 * 一次性迁移:把历史「绑定线」订阅刷成硬绑(pinned)+ 去掉残留静态额度。
 *
 * 背景(见 QUOTA-REDESIGN.md):额度重构后,绑定卡改为硬绑(assignmentPolicy="pinned"),
 * 由 fair-share 在拼车主人间公平切分共用号;不再下发静态 bucketLimits/weeklyBucketLimits。
 * 但历史订阅的 config 还是旧的 `preferred-dynamic`(会在池里漂移、不进 fair-share)且带着
 * 旧的静态额度。本脚本把它们就地刷新到新口径:
 *   - config.line === "bind" 且 config.assignmentPolicy === "preferred-dynamic"
 *     → assignmentPolicy = "pinned"
 *   - 删除 config.bucketLimits / config.weeklyBucketLimits(绑定卡归 fair-share)
 *   - 清空镜像列 Subscription.bucketLimits(运行时静态限额读它,清掉才完全交给 fair-share)
 * 号池线(line !== "bind")完全不动。空 config 的历史订阅运行时已默认 "pinned"(见
 * subscription-config.ts),无需处理。
 *
 * 用法(在 apps/server 下):
 *   预演(只统计、不写库):  pnpm tsx scripts/migrate-bind-cards-to-pinned.ts
 *   真正执行:               pnpm tsx scripts/migrate-bind-cards-to-pinned.ts --apply
 */

import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

// repo 根:本文件在 apps/server/scripts/(3 层)。与 prisma.service 同款 file: URL 解析,
// 保证无论 cwd 在哪都连到同一个库。
const projectRoot = resolve(__dirname, "../../..");

function resolveDatabaseUrl(): string {
  const rawUrl = process.env.DATABASE_URL ?? "file:./dev.db";
  if (!rawUrl.startsWith("file:")) return rawUrl;
  const rawPath = rawUrl.slice("file:".length);
  if (!rawPath || /^[A-Za-z]:/.test(rawPath) || rawPath.startsWith("/")) return rawUrl;
  return `file:${resolve(projectRoot, "prisma", rawPath).replace(/\\/g, "/")}`;
}

function parseConfig(raw: string | null): Record<string, any> | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    return c && typeof c === "object" ? c : null;
  } catch {
    return null;
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const prisma = new PrismaClient({ datasourceUrl: resolveDatabaseUrl() });

  let scanned = 0;
  let flipped = 0;
  let strippedCaps = 0;
  const samples: string[] = [];

  try {
    const subs = await prisma.subscription.findMany({
      select: { id: true, config: true, bucketLimits: true },
    });
    for (const sub of subs) {
      scanned++;
      const config = parseConfig(sub.config);
      if (!config || config.line !== "bind") continue;

      const isPreferredDynamic = String(config.assignmentPolicy || "").toLowerCase() === "preferred-dynamic";
      const hasConfigCaps = config.bucketLimits != null || config.weeklyBucketLimits != null;
      const hasColumnCaps = sub.bucketLimits != null && sub.bucketLimits !== "" && sub.bucketLimits !== "{}";
      if (!isPreferredDynamic && !hasConfigCaps && !hasColumnCaps) continue; // 已是新口径

      const next = { ...config };
      if (isPreferredDynamic) {
        next.assignmentPolicy = "pinned";
        flipped++;
      }
      if (hasConfigCaps) {
        delete next.bucketLimits;
        delete next.weeklyBucketLimits;
      }
      if (hasConfigCaps || hasColumnCaps) strippedCaps++;

      if (samples.length < 10) {
        samples.push(`${sub.id}: preferred-dynamic=${isPreferredDynamic} caps=${hasConfigCaps || hasColumnCaps}`);
      }

      if (apply) {
        await prisma.subscription.update({
          where: { id: sub.id },
          data: { config: JSON.stringify(next), bucketLimits: null },
        });
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`[migrate-bind-pinned] mode=${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`  scanned subscriptions: ${scanned}`);
  console.log(`  bind subs → pinned:    ${flipped}`);
  console.log(`  bind subs stripped static caps: ${strippedCaps}`);
  if (samples.length) console.log(`  samples:\n    ${samples.join("\n    ")}`);
  if (!apply) console.log(`  (dry-run — no rows written; re-run with --apply to persist)`);
}

main().catch((err) => {
  console.error("[migrate-bind-pinned] failed:", err);
  process.exitCode = 1;
});
