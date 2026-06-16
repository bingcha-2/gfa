/**
 * 一次性 backfill:把 `config` 列为空的订阅(主要是卡迁移订阅 card_*)从 legacy 列
 * 反推出 config 写回。读取侧已用 rowToConfig 回退,功能上不依赖本脚本;此脚本只是
 * 让 DB 数据干净(config 列填实),供直读 config 的代码 / 排查使用。
 *
 * 安全:只读 legacy 列(productEntitlements/bindings/...)→ 算出 config → 写 config。
 *       绝不改 bindings 本身、不动绑定的账号、不碰 config 已非空的订阅(catalog 下单的)。
 *
 * 用法(在仓库根目录,.env 提供 DATABASE_URL):
 *   预览(不写):   pnpm exec tsx scripts/backfill-subscription-config.ts
 *   实际写入:      pnpm exec tsx scripts/backfill-subscription-config.ts --apply
 */
import { PrismaClient } from "@prisma/client";

import { legacyColumnsToConfig } from "../apps/server/src/leasing/subscription/subscription-config";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

function parseProducts(json: string | null): string[] {
  try {
    const p = JSON.parse(String(json || "[]"));
    return Array.isArray(p) ? p.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

async function main() {
  console.log(APPLY ? "[backfill] APPLY 模式 —— 将写入 config" : "[backfill] DRY-RUN(加 --apply 才写)");

  // 1) 找 config 为空的订阅(NULL 或 空串),补出 config。
  const empties = await prisma.subscription.findMany({
    where: { OR: [{ config: null }, { config: "" }] },
    select: {
      id: true, status: true,
      productEntitlements: true, bucketLimits: true, bindings: true, levels: true,
      weight: true, deviceLimit: true, weeklyTokenLimit: true, windowMs: true,
    },
    orderBy: { id: "asc" },
  });

  console.log(`\n=== config 为空的订阅:${empties.length} 条 ===`);
  let bind = 0, pool = 0, written = 0;
  for (const r of empties) {
    const cfg = legacyColumnsToConfig(r as any);
    const line = String(cfg.line || "pool");
    if (line === "bind") bind++; else pool++;
    if (!APPLY && (bind + pool) <= 15) {
      console.log(`  ${r.id}  [${r.status}]  line=${line}  bindings=${r.bindings ?? "{}"}  products=${r.productEntitlements ?? "[]"}`);
    }
    if (APPLY) {
      await prisma.subscription.update({ where: { id: r.id }, data: { config: JSON.stringify(cfg) } });
      written++;
    }
  }
  console.log(`  → 推断:绑定(bind) ${bind} 条,号池(pool) ${pool} 条`);
  console.log(APPLY ? `  → 已写入 config:${written} 条` : "  → DRY-RUN,未写入");

  // 2) 顺带报告「会 409」的绑定订阅:productEntitlements 含某产品,但 bindings 没绑该产品。
  //    这些订阅用「已开通但未绑定的产品」时会被 lease 拒(此卡未开通该服务)。不需要卡 id。
  const actives = await prisma.subscription.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, customerId: true, productEntitlements: true, bindings: true },
    orderBy: { id: "asc" },
  });
  const ALL = ["antigravity", "codex", "anthropic"];
  const offenders: Array<{ id: string; missing: string[]; products: string[]; bindings: any }> = [];
  for (const s of actives) {
    let bmap: Record<string, unknown> = {};
    try { bmap = JSON.parse(String(s.bindings || "{}")) || {}; } catch { bmap = {}; }
    const hasAnyBinding = Object.values(bmap).some((v) => Number(v) > 0);
    if (!hasAnyBinding) continue; // 号池卡不受此规则限制
    const products = parseProducts(s.productEntitlements).filter((p) => ALL.includes(p));
    const missing = products.filter((p) => !(Number((bmap as any)[p]) > 0));
    if (missing.length > 0) offenders.push({ id: s.id, missing, products, bindings: bmap });
  }
  console.log(`\n=== 会 409 的绑定订阅(开通了某产品却没绑它)：${offenders.length} 条 ===`);
  for (const o of offenders.slice(0, 40)) {
    console.log(`  ${o.id}  已开通=[${o.products.join(",")}]  实际绑定=${JSON.stringify(o.bindings)}  → 用 [${o.missing.join(",")}] 会被 409`);
  }
  if (offenders.length > 40) console.log(`  …还有 ${offenders.length - 40} 条`);
  console.log("\n(这些 409 订阅本脚本不改 —— 需你决定:把它们改成号池卡 / 给它们加对应产品的绑定。)");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
