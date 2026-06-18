/**
 * 本地造数据(真实):把 exports/ 里导出的 129 条真实订阅 + 被绑账号 planType 灌进 fixture 库,
 * 用于对真实数据跑 rebuild-subscriptions-and-orders.ts 看洗出来的结果。仅本地手动用。
 *
 * 用法(apps/server 下):
 *   DATABASE_URL=file:./rebuild-fixture.db ROSETTA_DATA_DIR=/tmp/rebuild-rosetta \
 *     pnpm tsx scripts/seed-from-export.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

const projectRoot = resolve(__dirname, "../../..");
const exportsDir = resolve(projectRoot, "exports");
function resolveDatabaseUrl(): string {
  const rawUrl = process.env.DATABASE_URL ?? "file:./dev.db";
  if (!rawUrl.startsWith("file:")) return rawUrl;
  const rawPath = rawUrl.slice("file:".length);
  if (!rawPath || /^[A-Za-z]:/.test(rawPath) || rawPath.startsWith("/")) return rawUrl;
  return `file:${resolve(projectRoot, "prisma", rawPath).replace(/\\/g, "/")}`;
}

// 合成目录:不重算定价,只需 levelPrice 覆盖真实用到的 (product,level)、windowMs、shareCapacity。
const CATALOG = {
  products: ["anthropic", "codex", "antigravity"],
  usageTiers: { default: { bucketLimits: {}, weeklyTokenLimit: 0 } },
  pricing: {
    pool: { product: { anthropic: 0, codex: 0, antigravity: 0 }, usage: { default: 0 }, devicePerExtra: 0 },
    bind: {
      levelPrice: {
        anthropic: { pro: 1, "max-5x": 1, "max-20x": 1 },
        codex: { plus: 1, pro: 1 },
        antigravity: { pro: 1, ultra: 1 },
      },
      share: { "1": 0, "2": 0, "4": 0, "8": 0 },
      devicePerExtra: 0,
    },
  },
  durationDays: 30,
  windowMs: 18000000,
  shareCapacity: 8,
};

function d(v: string | null): Date | null {
  return v ? new Date(v) : null;
}

async function main() {
  const dataDir = process.env.ROSETTA_DATA_DIR || "/tmp/rebuild-rosetta";
  mkdirSync(dataDir, { recursive: true });

  // —— 从「带绑定账号」导出抽 planType,写成 rosetta 账号池文件 ——
  const bound = JSON.parse(readFileSync(resolve(exportsDir, "subscriptions-with-bound-accounts-2026-06-18.json"), "utf8"));
  const pools: Record<string, Map<number, any>> = { anthropic: new Map(), codex: new Map(), antigravity: new Map() };
  for (const sub of bound.subscriptions ?? []) {
    for (const ba of sub.boundAccounts ?? []) {
      const acc = ba.account;
      if (!acc || !(Number(acc.id) > 0) || !pools[ba.product]) continue;
      pools[ba.product].set(Number(acc.id), { id: Number(acc.id), planType: acc.planType, email: acc.email, enabled: acc.enabled !== false });
    }
  }
  const fileFor: Record<string, string> = { anthropic: "anthropic-accounts.json", codex: "codex-accounts.json", antigravity: "accounts.json" };
  for (const product of Object.keys(pools)) {
    writeFileSync(resolve(dataDir, fileFor[product]), JSON.stringify({ accounts: [...pools[product].values()] }, null, 2));
  }
  console.log(`[seed-export] planType accounts: anthropic=${pools.anthropic.size} codex=${pools.codex.size} antigravity=${pools.antigravity.size}`);

  const subs = JSON.parse(readFileSync(resolve(exportsDir, "subscriptions-2026-06-18.json"), "utf8"));

  const prisma = new PrismaClient({ datasourceUrl: resolveDatabaseUrl() });
  try {
    // 只替换订阅/订单/目录;保留 dev.db 里已有的客户和其他表(Account/Task 等)。
    await prisma.planOrder.deleteMany({});
    await prisma.subscription.deleteMany({});
    await prisma.planCatalog.deleteMany({ where: { version: 3 } });

    await prisma.planCatalog.create({ data: { version: 3, status: "PUBLISHED", config: JSON.stringify(CATALOG), publishedAt: new Date() } });

    // 客户:为缺的 customerId 追加占位客户(导出无客户表 → invitedById 一律 null,referrerId 本地缺省);
    // 已存在的客户保留不动(SQLite createMany 不支持 skipDuplicates,故先查已有 id 再插缺的)。
    const customerIds = [...new Set(subs.map((s: any) => s.customerId))] as string[];
    const existing = new Set((await prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true } })).map((c) => c.id));
    const missing = customerIds.filter((id) => !existing.has(id));
    if (missing.length) {
      await prisma.customer.createMany({
        data: missing.map((id) => ({ id, email: `${id}@fixture`, passwordHash: "x", referralCode: id })),
      });
    }

    for (const s of subs) {
      await prisma.subscription.create({
        data: {
          id: s.id,
          customerId: s.customerId,
          status: s.status,
          startsAt: d(s.startsAt) ?? new Date(),
          expiresAt: d(s.expiresAt),
          activatedFromOrderId: s.activatedFromOrderId ?? null,
          migratedFromKey: s.migratedFromKey ?? null,
          config: s.config ?? null,
          catalogVersion: s.catalogVersion ?? null,
          productEntitlements: s.productEntitlements ?? "[]",
          bucketLimits: s.bucketLimits ?? null,
          bindings: s.bindings ?? null,
          levels: s.levels ?? null,
          weight: s.weight ?? 1,
          priority: s.priority ?? 0,
          deviceLimit: s.deviceLimit ?? 1,
          weeklyTokenLimit: s.weeklyTokenLimit ?? null,
          windowMs: s.windowMs ?? 18000000,
          backingKeyValue: s.backingKeyValue,
          windowState: s.windowState ?? null,
          createdAt: d(s.createdAt) ?? new Date(),
        },
      });
    }

    const total = await prisma.subscription.count();
    const active = await prisma.subscription.count({ where: { status: "ACTIVE" } });
    console.log(`[seed-export] customers=${customerIds.length}  subs=${total}  active=${active}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[seed-export] failed:", err);
  process.exitCode = 1;
});
