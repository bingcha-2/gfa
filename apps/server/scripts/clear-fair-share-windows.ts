/**
 * 一次性恢复:清空 FairShareWindow,逼绑定卡从下一个上游快照干净冷启动。
 *
 * 背景(冷启动归因 bug):fair-share 重构(commit bae6676)的迁移已清过一次 FairShareWindow
 * 强制冷启动,但旧版 fair-share-tracker 冷建 tracker 时 lastFraction 占位为 1.0,冷启动后
 * 第一个上游快照会按 Δ账号 = max(0, 1.0 − fraction) 把「冷启动前别人已烧掉的额度」整段归因给
 * 当时活跃的卡。周窗口尤甚:账号常已烧到个位数(如剩 6%)→ 首个活跃卡被砸 ~94% ≫ 自己份额
 * (~10%)→ 血条秒归零、被拦。该 buggy 值已写进 FairShareWindow,只部署修复不会自动消失
 * (load() 会把坏行读回,primed=true → 仍被拦),最长要等下个周 reset(7 天)才自愈。
 *
 * 修复(已落地 fair-share-tracker.ts):tracker 加 primed 标志,冷建后首个有效快照「采纳」其
 * fraction 为低水位、不归因(QUOTA-REDESIGN §9/§344 冷启动从宽)。**部署该修复后再跑本脚本**
 * 清掉坏行,下一次冷启动就会正确采纳当前基线,周血条立即恢复正常。
 *
 * ⚠️ 先决条件:必须已部署带 primed 修复的服务端再清表;否则清完又会被同一个 bug 重新写坏。
 *
 * 用法(在 apps/server 下):
 *   预演(只统计、不写库):    pnpm tsx scripts/clear-fair-share-windows.ts
 *   只清周窗口(推荐,精准):  pnpm tsx scripts/clear-fair-share-windows.ts --weekly-only --apply
 *   全清(5h+周,等同迁移):   pnpm tsx scripts/clear-fair-share-windows.ts --apply
 *   限定 provider:            pnpm tsx scripts/clear-fair-share-windows.ts --provider=anthropic --apply
 */

import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

// 周窗口 key 后缀,与 fair-share-tracker.ts 的 WEEKLY_SUFFIX 一致(那边未导出,这里就地约定)。
const WEEKLY_SUFFIX = "::weekly";

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

function parseProvider(): string | undefined {
  const arg = process.argv.find((a) => a.startsWith("--provider="));
  return arg ? arg.slice("--provider=".length) : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const weeklyOnly = process.argv.includes("--weekly-only");
  const provider = parseProvider();

  const where: { provider?: string; bucket?: { endsWith: string } } = {};
  if (provider) where.provider = provider;
  if (weeklyOnly) where.bucket = { endsWith: WEEKLY_SUFFIX };

  const prisma = new PrismaClient({ datasourceUrl: resolveDatabaseUrl() });
  try {
    const total = await prisma.fairShareWindow.count();
    const matched = await prisma.fairShareWindow.count({ where });

    console.log("=== clear-fair-share-windows ===");
    console.log(`  mode:        ${apply ? "APPLY (写库)" : "dry-run (只统计)"}`);
    console.log(`  scope:       ${weeklyOnly ? "周窗口(bucket *::weekly)" : "全部窗口(5h + 周)"}`);
    console.log(`  provider:    ${provider ?? "(全部)"}`);
    console.log(`  rows total:  ${total}`);
    console.log(`  rows match:  ${matched}`);

    if (matched === 0) {
      console.log("  无匹配行,跳过。");
      return;
    }

    if (apply) {
      const { count } = await prisma.fairShareWindow.deleteMany({ where });
      console.log(`  deleted:     ${count}`);
      console.log("  ✅ 已清空。下一次上游快照将干净冷启动并采纳当前基线(需服务端已含 primed 修复)。");
    } else {
      console.log(`  (dry-run — 未写库;确认无误后加 --apply 落库)`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
