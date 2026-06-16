/**
 * 一次性还原:此前 fix-hybrid --apply 把这 2 张「anthropic 绑定卡」误转成了号池
 * (清空 bindings + config=pool)。按新规则——带绑定的卡 = 绑定卡,只服务所绑产品,
 * codex/antigravity 一律 409——它们应是 anthropic 绑定卡。这里把绑定还原回去。
 *
 * 安全:只改这 2 个明确 id 的 bindings + config(用 legacyColumnsToConfig 重算为 bind),
 *       不动 productEntitlements/bucketLimits/用量。默认 dry-run,--apply 才写。
 *       写后需重启服务让内存订阅重载。
 *
 * 用法:pnpm exec tsx scripts/restore-bound-cards.ts [--apply]
 */
import { PrismaClient } from "@prisma/client";

import { legacyColumnsToConfig } from "../apps/server/src/leasing/subscription/subscription-config";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

// 原绑定来自 access-keys.json 文件卡记录(两张都是 anthropic:12)。
const RESTORE: Array<{ id: string; bindings: Record<string, number> }> = [
  { id: "card_mqejorly_2da888c2", bindings: { anthropic: 12 } },
  { id: "card_mqenr09z_76cb7b1d", bindings: { anthropic: 12 } },
];

async function main() {
  console.log(APPLY ? "[restore] APPLY 模式 —— 将写入" : "[restore] DRY-RUN(加 --apply 才写)");
  for (const r of RESTORE) {
    const row = await prisma.subscription.findUnique({
      where: { id: r.id },
      select: {
        id: true, config: true,
        productEntitlements: true, bucketLimits: true, bindings: true, levels: true,
        weight: true, deviceLimit: true, weeklyTokenLimit: true, windowMs: true,
      },
    });
    if (!row) { console.log(`  skip ${r.id}: 订阅不存在`); continue; }
    const bindingsJson = JSON.stringify(r.bindings);
    const config = legacyColumnsToConfig({ ...(row as any), bindings: bindingsJson });
    console.log(`  ${r.id}: bindings → ${bindingsJson}, config.line → ${config.line}`);
    if (APPLY) {
      await prisma.subscription.update({
        where: { id: r.id },
        data: { bindings: bindingsJson, config: JSON.stringify(config) },
      });
    }
  }
  console.log(APPLY ? "  → 已还原为绑定卡。⚠ 重启服务(pnpm start:stop && start:daemon)生效。" : "  → DRY-RUN,未写入。");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
