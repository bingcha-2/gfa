/**
 * 一次性修复:把「绑定 + 按量卖其它产品」的混合卡订阅转成号池卡。
 *
 * 背景:卡迁移产生过这种卡 —— bindings={anthropic:N} 但 bucketLimits 含 antigravity / codex
 * 前缀的计费桶(按量卖了那些产品)。按「绑定卡只服务绑定产品」规则,用 antigravity/codex 会 409
 * (此卡未开通该服务)。这类卡本质按量卖,应为号池卡:清空 bindings → line=pool,
 * 让所有已开通产品都走号池按量(仍受 bucketLimits 约束)。
 *
 * 安全:只对 isMeteredHybrid 命中的订阅,清 bindings + 用 legacyColumnsToConfig 重算 pool config。
 *       不碰 productEntitlements / bucketLimits / 用量。纯绑定卡、纯号池卡都不动。
 * ⚠ 跑完需重启服务(pnpm start:stop && start:daemon)让内存订阅 record 重新装载。
 *
 * 用法(仓库根目录):
 *   预览:  pnpm exec tsx scripts/fix-hybrid-bound-to-pool.ts
 *   写入:  pnpm exec tsx scripts/fix-hybrid-bound-to-pool.ts --apply
 */
import { PrismaClient } from "@prisma/client";

import { isMeteredHybrid, legacyColumnsToConfig } from "../apps/server/src/leasing/subscription/subscription-config";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(APPLY ? "[fix-hybrid] APPLY 模式 —— 将写入" : "[fix-hybrid] DRY-RUN(加 --apply 才写)");

  const rows = await prisma.subscription.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true, config: true,
      productEntitlements: true, bucketLimits: true, bindings: true, levels: true,
      weight: true, deviceLimit: true, weeklyTokenLimit: true, windowMs: true,
    },
    orderBy: { id: "asc" },
  });

  const targets = rows.filter((r) =>
    isMeteredHybrid({ productEntitlements: r.productEntitlements, bindings: r.bindings, bucketLimits: r.bucketLimits }),
  );

  console.log(`\n=== 混合卡(绑定+按量卖其它产品,会 409):${targets.length} 条 ===`);
  let written = 0;
  for (const r of targets) {
    // 清空 bindings → legacyColumnsToConfig 据此判定为 pool。
    const poolConfig = legacyColumnsToConfig({ ...(r as any), bindings: "{}" });
    console.log(`  ${r.id}  原 bindings=${r.bindings}  products=${r.productEntitlements}  → 转号池 line=${poolConfig.line}`);
    if (APPLY) {
      await prisma.subscription.update({
        where: { id: r.id },
        data: { config: JSON.stringify(poolConfig), bindings: "{}" },
      });
      written++;
    }
  }

  if (APPLY) {
    console.log(`\n  → 已转号池:${written} 条。⚠ 请重启服务(pnpm start:stop && pnpm start:daemon)让内存生效。`);
  } else {
    console.log("\n  → DRY-RUN,未写入。确认无误后加 --apply。");
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
