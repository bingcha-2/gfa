/**
 * 一次性迁移:按「现有代码规则」重整订阅 + 重建订单(一订阅一单)。
 *
 * 需求(本次):
 *   1. 删除非活跃数据:status !== ACTIVE 的 Subscription 直接删除(含其遗留 PlanOrder)。
 *   2. 把保留的 ACTIVE 订阅 config 按现有口径重算规整(现状数据有 bug:绑定卡还是
 *      preferred-dynamic、带残留静态额度、缺 salesSeatCapacity、迁移老卡 config 空)。
 *   3. 全部重新生成 PlanOrder:清掉所有现存 PlanOrder,为每条 ACTIVE 订阅生成且仅生成一条
 *      GRANT/PAID 订单(一订阅一单),并回填 Subscription.activatedFromOrderId。
 *
 * 「符合现有逻辑」靠直接复用生产纯函数实现:
 *   - rowToConfig            解析订阅的有效 config(显式 config 优先,空则回退 legacy 列)
 *   - computePurchase        绑定线按 selection 重算 canonical config(line/levels/shareSeats/
 *                            shareCapacity/weight/assignmentPolicy=pinned/deviceLimit/windowMs)
 *   - salesSeatCapacityFor   补 enrichUnifiedBindConfig 那一步的 salesSeatCapacity(per product)
 *   - seatWeight / isExclusive 份额与独享判定
 * 绑定卡因此天然得到新口径:pinned + 无静态 bucketLimits/weeklyBucketLimits + 补齐 salesSeatCapacity。
 *
 * 判断口径(就地决策,见脚本顶部 README 注释 / 汇报):
 *   - 号池线(pool):config 自洽(bucketLimits/weeklyTokenLimit 即解析值,无重构 bug),只清形不重算;
 *     订单 selection.usageTier 用 catalog.usageTiers 反查,查不到留空(仅审计用)。
 *   - 迁移老卡缺 levels:绑定线按 catalog 默认档位补(anthropic→max-20x / codex→pro / antigravity→ultra,
 *     源自 mergeSupplyPolicies);未绑账号的归号池。
 *   - shareSeats 非 {1,2,4,8} → 向下取最近合法档(≥1、≤shareCapacity)。
 *   - PlanOrder:amountCents=0 / payChannel=GRANT / status=PAID;outTradeNo 由 sub.id 派生(幂等);
 *     paidAt=createdAt=sub.createdAt;expiresAt=sub.expiresAt ?? createdAt;referrerId=customer.invitedById;
 *     catalogVersion=已发布目录版本;config=规整后 config;selection=反推。
 *   - 绑定订阅的镜像列 Subscription.bucketLimits 清空(归 fair-share);号池保留。
 *
 * 用法(在 apps/server 下):
 *   预演(只统计、不写库):  pnpm tsx scripts/rebuild-subscriptions-and-orders.ts
 *   真正执行:               pnpm tsx scripts/rebuild-subscriptions-and-orders.ts --apply
 */

import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

import { computePurchase, type CatalogConfig, type Selection } from "../src/leasing/plan-catalog/pricing";
import { mergeSupplyPolicies, salesSeatCapacityFor } from "../src/leasing/plan-catalog/unified-entitlement";
import { defaultDataDir, readJson } from "../src/leasing/rosetta/lib/store";
import { isExclusive, seatWeight } from "../src/leasing/subscription/seat";
import { rowToConfig } from "../src/leasing/subscription/subscription-config";

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

const SEAT_OPTIONS = [1, 2, 4, 8] as const;

/** 把任意份数夹到最近的合法席位档(向下取,≥1、≤shareCapacity)。现状数据已是 1/2/4/8,仅防御。 */
export function clampSeats(raw: number, shareCapacity: number): number {
  const n = Math.max(1, Math.floor(Number(raw) || 1));
  const cap = Math.max(1, Math.floor(Number(shareCapacity) || 8));
  let best = 1;
  for (const opt of SEAT_OPTIONS) {
    if (opt <= n && opt <= cap) best = opt;
  }
  return best;
}

/** 号池订单的 usageTier 反查:按 bucketLimits + weeklyTokenLimit 匹配 catalog.usageTiers,查不到返回 ""。 */
export function recoverUsageTier(
  catalog: CatalogConfig,
  bucketLimits: Record<string, number>,
  weeklyTokenLimit: number,
): string {
  const target = JSON.stringify(bucketLimits ?? {});
  for (const [name, tier] of Object.entries(catalog.usageTiers ?? {})) {
    if (JSON.stringify(tier.bucketLimits ?? {}) === target && Number(tier.weeklyTokenLimit) === Number(weeklyTokenLimit)) {
      return name;
    }
  }
  return "";
}

/** product → 该产品账号池文件名(与 access-key.service.poolFileFor 一致)。 */
function poolFileFor(product: string): string | null {
  if (product === "codex") return "codex-accounts.json";
  if (product === "anthropic") return "anthropic-accounts.json";
  if (product === "antigravity") return "accounts.json";
  return null;
}

/** 读各产品账号池,建 product → (accountId → planType) 映射,用于按所绑账号推真实档位。 */
export function loadPoolPlanTypes(dataDir: string): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>();
  for (const product of ["anthropic", "codex", "antigravity"]) {
    const file = poolFileFor(product);
    if (!file) continue;
    const pool = readJson(`${dataDir}/${file}`, { accounts: [] });
    const accounts = Array.isArray(pool.accounts) ? pool.accounts : [];
    const m = new Map<number, string>();
    for (const acc of accounts) {
      const id = Number(acc?.id);
      const planType = String(acc?.planType || "").trim();
      if (id > 0 && planType) m.set(id, planType);
    }
    out.set(product, m);
  }
  return out;
}

/** 绑定卡某产品的档位解析:所绑账号的 planType 优先,无则返回 undefined(由调用方回退默认档)。 */
export type LevelResolver = (product: string, accountId: number | undefined) => string | undefined;

export interface NormalizedSub {
  /** 规整后的 config 对象(写回 Subscription.config) */
  config: Record<string, any>;
  /** 反推出的下单 selection(写入 PlanOrder.selection) */
  selection: Selection;
  /** 写回 Subscription.bucketLimits 镜像列的值:绑定线 null(归 fair-share),号池保留 JSON */
  bucketLimitsColumn: string | null;
  line: "bind" | "pool";
}

/**
 * 按现有代码规则把一条订阅的「有效 config」规整成新口径,并反推下单 selection。
 * 纯函数(无 IO),便于单测。绑定线走 computePurchase 重算 → 天然 pinned + 去静态额度。
 */
export function normalizeSubscription(
  catalog: CatalogConfig,
  effective: Record<string, any>,
  resolveLevel?: LevelResolver,
): NormalizedSub {
  const products: string[] = Array.isArray(effective.products) ? effective.products.map(String) : [];
  const deviceLimit = Math.max(1, Math.floor(Number(effective.deviceLimit) || 1));
  const policies = mergeSupplyPolicies(catalog);

  // 绑定线判定:显式 line==="bind",或(legacy 回退后)绑了真实账号。
  const bindings: Record<string, number> = {};
  for (const [product, accountId] of Object.entries(effective.bindings ?? {})) {
    if (Number(accountId) > 0) bindings[product] = Number(accountId);
  }
  const isBind = effective.line === "bind" || Object.keys(bindings).length > 0;

  if (isBind) {
    const shareCapacity = Math.max(1, Math.floor(Number(effective.shareCapacity) || 8));
    const shareSeats = clampSeats(seatWeight(effective), shareCapacity);

    // levels 档位口径:① 已有 levels 保留(下单时的购买意图,权威);
    // ② 缺失则按所绑账号的真实 planType 推(loadPoolPlanTypes);③ 再不行回退 catalog 默认档。
    const levels: Record<string, string> = { ...(effective.levels ?? {}) };
    for (const product of products) {
      if (levels[product]) continue;
      const fromAccount = resolveLevel?.(product, bindings[product]);
      levels[product] = fromAccount || policies[product]?.defaultLevel || "";
    }

    // 独享(exclusive)经 selection 传给 computeBind 原生处理(它会强制 shareSeats=shareCapacity 并输出 exclusive)。
    const exclusive = isExclusive(effective);
    const selection: Selection = {
      line: "bind",
      items: products.map((product) => ({ product, level: String(levels[product] || "") })),
      shareSeats,
      deviceLimit,
      ...(exclusive ? { exclusive: true } : {}),
    };

    // 现有逻辑:computePurchase 出 canonical bind config(pinned、无静态额度、含 exclusive);再补 salesSeatCapacity + 绑定。
    const { config } = computePurchase(catalog, selection);
    config.salesSeatCapacity = Object.fromEntries(
      products.map((product) => [product, salesSeatCapacityFor(catalog, product, String(levels[product] || ""), shareCapacity)]),
    );
    if (Object.keys(bindings).length > 0) config.bindings = bindings;

    return { config, selection, bucketLimitsColumn: null, line: "bind" };
  }

  // 号池线:config 自洽,不重算定价(无重构 bug),只规整形状。
  const bucketLimits: Record<string, number> = (effective.bucketLimits && typeof effective.bucketLimits === "object" ? effective.bucketLimits : {}) as Record<string, number>;
  const weeklyTokenLimit = Number.isFinite(Number(effective.weeklyTokenLimit)) ? Number(effective.weeklyTokenLimit) : 0;
  const windowMs = Math.floor(Number(effective.windowMs) || Number(catalog.windowMs) || 18_000_000);

  const config: Record<string, any> = {
    line: "pool",
    products,
    bucketLimits,
    weeklyTokenLimit,
    deviceLimit,
    windowMs,
  };
  const selection: Selection = {
    line: "pool",
    products,
    usageTier: recoverUsageTier(catalog, bucketLimits, weeklyTokenLimit),
    deviceLimit,
  };
  return { config, selection, bucketLimitsColumn: JSON.stringify(bucketLimits), line: "pool" };
}

/** 幂等的 outTradeNo:同一订阅永远生成同值(便于重复运行不产生新单)。 */
function migrateOutTradeNo(subId: string): string {
  return `gfa-rebuild-${subId}`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const prisma = new PrismaClient({ datasourceUrl: resolveDatabaseUrl() });

  const stats = {
    scanned: 0,
    deletedInactiveSubs: 0,
    deletedInactiveOrders: 0,
    droppedNoProduct: 0,
    droppedPool: 0,
    keptActive: 0,
    normalizedBind: 0,
    normalizedPool: 0,
    ordersDeleted: 0,
    ordersCreated: 0,
    fairShareReset: 0,
    errors: [] as string[],
  };
  const samples: string[] = [];

  try {
    const published = await prisma.planCatalog.findFirst({ where: { status: "PUBLISHED" } });
    if (!published) {
      throw new Error("没有已发布的 PlanCatalog,无法重算绑定线 config / 反推订单。先发布目录再跑。");
    }
    const catalog = JSON.parse(published.config) as CatalogConfig;
    console.log(`[rebuild] published catalog version=${published.version}`);

    // 账号池 planType:绑定卡缺档位时按所绑账号的真实套餐推档(见 loadPoolPlanTypes)。
    const dataDir = process.env.ROSETTA_DATA_DIR || defaultDataDir();
    const poolPlanTypes = loadPoolPlanTypes(dataDir);
    const resolveLevel: LevelResolver = (product, accountId) => {
      if (!(Number(accountId) > 0)) return undefined;
      return poolPlanTypes.get(product)?.get(Number(accountId));
    };
    const planTypeCount = [...poolPlanTypes.values()].reduce((n, m) => n + m.size, 0);
    console.log(`[rebuild] rosetta dataDir=${dataDir}  accounts with planType=${planTypeCount}`);

    const subs = await prisma.subscription.findMany();
    stats.scanned = subs.length;

    // 删除集 = 非活跃 ∪ 活跃但无产品(残留废卡:无 product 无法取号,如老卡密迁移时 productEntitlements 为空)。
    const active: typeof subs = [];
    const drop: typeof subs = [];
    for (const s of subs) {
      if (s.status !== "ACTIVE") {
        drop.push(s);
        continue;
      }
      const eff = rowToConfig(s as any);
      const products = Array.isArray(eff.products) ? (eff.products as unknown[]).filter(Boolean) : [];
      if (products.length === 0) {
        drop.push(s);
        stats.droppedNoProduct++;
        continue;
      }
      // 不再有号池:只保留绑定线(拼车/硬绑);号池 / 轮换 / 无真实绑定的一律删除。
      const boundCount = Object.values((eff.bindings as Record<string, unknown>) ?? {}).filter((v) => Number(v) > 0).length;
      const isBind = eff.line === "bind" || boundCount > 0;
      if (!isBind) {
        drop.push(s);
        stats.droppedPool++;
        continue;
      }
      active.push(s);
    }
    stats.keptActive = active.length;

    // —— 1. 删除上述订阅 + 其遗留订单 ——
    const dropIds = drop.map((s) => s.id);
    if (dropIds.length) {
      stats.deletedInactiveOrders = await prisma.planOrder.count({ where: { subscriptionId: { in: dropIds } } });
      stats.deletedInactiveSubs = dropIds.length;
      if (apply) {
        await prisma.planOrder.deleteMany({ where: { subscriptionId: { in: dropIds } } });
        await prisma.subscription.deleteMany({ where: { id: { in: dropIds } } });
      }
    }

    // —— 2. 规整 ACTIVE 订阅 config + 3. 一订阅一单 ——
    // 全部重新生成 → 清空整张 PlanOrder 表,再逐订阅重建。
    stats.ordersDeleted = await prisma.planOrder.count();
    if (apply) {
      await prisma.planOrder.deleteMany({});
    }

    for (const sub of active) {
      try {
        const effective = rowToConfig(sub as any);
        const norm = normalizeSubscription(catalog, effective, resolveLevel);
        if (norm.line === "bind") stats.normalizedBind++;
        else stats.normalizedPool++;

        const outTradeNo = migrateOutTradeNo(sub.id);
        const createdAt = sub.createdAt;
        const expiresAt = sub.expiresAt ?? sub.createdAt;
        const referrer = await prisma.customer.findUnique({ where: { id: sub.customerId }, select: { invitedById: true } });

        if (apply) {
          // 规整后的 config + 镜像列写回订阅。
          await prisma.subscription.update({
            where: { id: sub.id },
            data: {
              config: JSON.stringify(norm.config),
              bucketLimits: norm.bucketLimitsColumn,
              catalogVersion: published.version,
            },
          });

          const order = await prisma.planOrder.create({
            data: {
              customerId: sub.customerId,
              subscriptionId: sub.id,
              amountCents: 0,
              payChannel: "GRANT",
              outTradeNo,
              status: "PAID",
              paidAt: createdAt,
              expiresAt,
              referrerId: referrer?.invitedById ?? null,
              catalogVersion: published.version,
              selection: JSON.stringify(norm.selection),
              config: JSON.stringify(norm.config),
              createdAt,
            } as any,
          });
          // 回填订阅→订单的权威链路。
          await prisma.subscription.update({ where: { id: sub.id }, data: { activatedFromOrderId: order.id } });
        }
        stats.ordersCreated++;

        if (samples.length < 12) {
          samples.push(`${sub.id} [${norm.line}] → ${outTradeNo}  cfg=${JSON.stringify(norm.config).slice(0, 120)}`);
        }
      } catch (err: any) {
        stats.errors.push(`${sub.id}: ${err?.message || err}`);
      }
    }

    // —— 4. fair-share 状态清理 ——
    // 洗后整个 pinned 拓扑重建:绑定卡所在账号的 Σw/D 全变了、号池卡本不该有 fair-share 行、
    // 已删订阅的行是孤儿 —— 整张表已无有效行,故清空 FairShareWindow,逼所有卡从下个上游窗口干净冷启动
    // (重构方案 §10:冷启动被接受,上游 429 兜底,下个 reset 自愈)。
    stats.fairShareReset = await prisma.fairShareWindow.count();
    if (apply) await prisma.fairShareWindow.deleteMany({});
  } finally {
    await prisma.$disconnect();
  }

  console.log(`[rebuild] mode=${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`  scanned subscriptions:        ${stats.scanned}`);
  console.log(`  subs deleted:                 ${stats.deletedInactiveSubs} (+${stats.deletedInactiveOrders} their orders; no-product=${stats.droppedNoProduct}, pool=${stats.droppedPool})`);
  console.log(`  active subs kept/normalized:  ${stats.keptActive}  (bind=${stats.normalizedBind}, pool=${stats.normalizedPool})`);
  console.log(`  PlanOrders wiped:             ${stats.ordersDeleted}`);
  console.log(`  PlanOrders regenerated:       ${stats.ordersCreated}`);
  console.log(`  FairShareWindow rows cleared (cold restart): ${stats.fairShareReset}`);
  if (stats.errors.length) {
    console.log(`  ERRORS (${stats.errors.length}):`);
    for (const e of stats.errors) console.log(`    - ${e}`);
  }
  if (samples.length) console.log(`  samples:\n    ${samples.join("\n    ")}`);
  if (!apply) console.log(`  (dry-run — 未写库;确认无误后加 --apply 落库)`);
}

// 仅作为脚本入口运行;被单测 import 纯函数时不触发迁移。
if (require.main === module) {
  main().catch((err) => {
    console.error("[rebuild] failed:", err);
    process.exitCode = 1;
  });
}
