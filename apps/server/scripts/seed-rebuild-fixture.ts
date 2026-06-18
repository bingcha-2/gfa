/**
 * 本地造数据:为 rebuild-subscriptions-and-orders.ts 的端到端验证铺一套 fixture。
 * 仅供本地手动跑,不进运行时。覆盖:catalog 绑定卡(带 redesign bug)、迁移老卡(空 config,
 * 缺档位)、号池、CANCELLED(应被删)、独享、多订阅同客户、推荐人(referrerId)。
 *
 * 用法(在 apps/server 下,DATABASE_URL/ROSETTA_DATA_DIR 指向 fixture):
 *   DATABASE_URL=file:./rebuild-fixture.db ROSETTA_DATA_DIR=/tmp/rebuild-rosetta \
 *     pnpm tsx scripts/seed-rebuild-fixture.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

const projectRoot = resolve(__dirname, "../../..");
function resolveDatabaseUrl(): string {
  const rawUrl = process.env.DATABASE_URL ?? "file:./dev.db";
  if (!rawUrl.startsWith("file:")) return rawUrl;
  const rawPath = rawUrl.slice("file:".length);
  if (!rawPath || /^[A-Za-z]:/.test(rawPath) || rawPath.startsWith("/")) return rawUrl;
  return `file:${resolve(projectRoot, "prisma", rawPath).replace(/\\/g, "/")}`;
}

const CATALOG = {
  products: ["anthropic", "codex", "antigravity"],
  usageTiers: {
    small: { bucketLimits: { "anthropic-claude": 50000 }, weeklyTokenLimit: 250000 },
    large: { bucketLimits: { "anthropic-claude": 150000 }, weeklyTokenLimit: 750000 },
  },
  pricing: {
    pool: { product: { anthropic: 6900, codex: 3900, antigravity: 3900 }, usage: { small: 0, large: 3000 }, devicePerExtra: 900 },
    bind: {
      levelPrice: {
        anthropic: { pro: 9900, "max-5x": 15900, "max-20x": 29900 },
        codex: { plus: 13900, pro: 19900 },
        antigravity: { pro: 11900, ultra: 19900 },
      },
      share: { "1": 0, "2": -2000, "4": -4000, "8": 0 },
      devicePerExtra: 900,
    },
  },
  durationDays: 30,
  windowMs: 18000000,
};

async function main() {
  const dataDir = process.env.ROSETTA_DATA_DIR || "/tmp/rebuild-rosetta";
  mkdirSync(dataDir, { recursive: true });
  // 账号池:账号 16=max-5x、20=max-20x、codex 7=pro。绑定卡缺档位时按这里的 planType 推。
  writeFileSync(`${dataDir}/anthropic-accounts.json`, JSON.stringify({ accounts: [{ id: 16, planType: "max-5x", email: "acct16@t" }, { id: 20, planType: "max-20x", email: "acct20@t" }] }, null, 2));
  writeFileSync(`${dataDir}/codex-accounts.json`, JSON.stringify({ accounts: [{ id: 7, planType: "pro", email: "acct7@t" }] }, null, 2));
  writeFileSync(`${dataDir}/accounts.json`, JSON.stringify({ accounts: [] }, null, 2));

  const prisma = new PrismaClient({ datasourceUrl: resolveDatabaseUrl() });
  const now = new Date();
  const in30d = new Date(now.getTime() + 30 * 86400_000);

  try {
    // 清 fixture 库相关表(只在 fixture 库跑)。
    await prisma.planOrder.deleteMany({});
    await prisma.subscription.deleteMany({});
    await prisma.planCatalog.deleteMany({});
    await prisma.customer.deleteMany({});

    await prisma.customer.create({ data: { id: "cust_R", email: "r@t", passwordHash: "x", referralCode: "R1" } });
    await prisma.customer.create({ data: { id: "cust_A", email: "a@t", passwordHash: "x", referralCode: "A1", invitedById: "cust_R" } });
    await prisma.customer.create({ data: { id: "cust_B", email: "b@t", passwordHash: "x", referralCode: "B1" } });

    await prisma.planCatalog.create({ data: { version: 3, status: "PUBLISHED", config: JSON.stringify(CATALOG), publishedAt: now } });

    const base = { startsAt: now, expiresAt: in30d, deviceLimit: 1, windowMs: 18000000 };

    // 1) catalog 绑定卡 + redesign bug:preferred-dynamic + 残留静态额度。
    await prisma.subscription.create({
      data: {
        ...base, id: "sub_bind_buggy", customerId: "cust_A", status: "ACTIVE", backingKeyValue: "k_bind_buggy", weight: 2,
        productEntitlements: '["anthropic"]', levels: '{"anthropic":"max-20x"}', bindings: '{"anthropic":16}',
        bucketLimits: '{"anthropic-claude":32152975}',
        config: JSON.stringify({ line: "bind", products: ["anthropic"], levels: { anthropic: "max-20x" }, shareSeats: 2, shareCapacity: 8, weight: 2, assignmentPolicy: "preferred-dynamic", deviceLimit: 1, windowMs: 18000000, salesSeatCapacity: { anthropic: 10 }, bucketLimits: { "anthropic-claude": 32152975 }, weeklyBucketLimits: { "anthropic-claude": 100192073 }, bindings: { anthropic: 16 } }),
      },
    });

    // 2) 迁移老卡:空 config、绑账号 16、无 levels → 按 planType(max-5x)推档。
    await prisma.subscription.create({
      data: { ...base, id: "sub_legacy_bind", customerId: "cust_B", status: "ACTIVE", backingKeyValue: "k_legacy_bind", weight: 1, productEntitlements: '["anthropic"]', bindings: '{"anthropic":16}', config: null },
    });

    // 3) 迁移老卡 codex:绑账号 7 → planType pro。
    await prisma.subscription.create({
      data: { ...base, id: "sub_legacy_codex", customerId: "cust_B", status: "ACTIVE", backingKeyValue: "k_legacy_codex", weight: 1, productEntitlements: '["codex"]', bindings: '{"codex":7}', config: null },
    });

    // 4) 号池。
    await prisma.subscription.create({
      data: { ...base, deviceLimit: 2, id: "sub_pool", customerId: "cust_A", status: "ACTIVE", backingKeyValue: "k_pool", weight: 1, productEntitlements: '["anthropic"]', bucketLimits: '{"anthropic-claude":150000}', weeklyTokenLimit: 750000, config: JSON.stringify({ line: "pool", products: ["anthropic"], bucketLimits: { "anthropic-claude": 150000 }, weeklyTokenLimit: 750000, deviceLimit: 2, windowMs: 18000000 }) },
    });

    // 5) CANCELLED(同客户 cust_A 的旧订阅)→ 应被删。
    await prisma.subscription.create({
      data: { ...base, id: "sub_cancelled", customerId: "cust_A", status: "CANCELLED", backingKeyValue: "k_cancelled", weight: 1, productEntitlements: '["anthropic"]', config: null },
    });

    // 6) 独享:exclusive=true,绑账号 20。
    await prisma.subscription.create({
      data: { ...base, id: "sub_exclusive", customerId: "cust_R", status: "ACTIVE", backingKeyValue: "k_excl", weight: 8, productEntitlements: '["anthropic"]', levels: '{"anthropic":"max-20x"}', bindings: '{"anthropic":20}', config: JSON.stringify({ line: "bind", products: ["anthropic"], levels: { anthropic: "max-20x" }, shareSeats: 8, shareCapacity: 8, weight: 8, exclusive: true, assignmentPolicy: "pinned", deviceLimit: 1, windowMs: 18000000, bindings: { anthropic: 20 } }) },
    });

    // 一条陈旧 PlanOrder(验证会被清空重建)。
    await prisma.planOrder.create({ data: { id: "stale_order", customerId: "cust_A", subscriptionId: "sub_pool", amountCents: 0, payChannel: "GRANT", outTradeNo: "stale-xyz", status: "PAID", paidAt: now, expiresAt: now } });

    const subs = await prisma.subscription.count();
    const orders = await prisma.planOrder.count();
    console.log(`[seed] dataDir=${dataDir}  subs=${subs}  orders=${orders}  catalog v3 published`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exitCode = 1;
});
