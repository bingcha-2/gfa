// Idempotent demo seed for the console billing-IA redesign.
// Adds a few recognizable rows (emails @demo.console.local, orders DEMO-*) so the
// new console screens have something to show. Re-runnable: wipes prior demo rows first.
// Touches ONLY demo rows — never the real dev data. Run: node scripts/seed-console-demo.mjs
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const defaultDatabaseUrl = "file:./dev.db";
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = defaultDatabaseUrl;

function resolveDatabaseUrl(rawUrl) {
  if (!rawUrl.startsWith("file:")) return rawUrl;
  const rawPath = rawUrl.slice("file:".length);
  if (!rawPath || /^[A-Za-z]:/.test(rawPath) || rawPath.startsWith("/")) return rawUrl;
  return `file:${resolve(rootDir, "prisma", rawPath).replace(/\\/g, "/")}`;
}

const DOMAIN = "@demo.console.local";
// bcrypt hash for password "admin123" (same as the default admin seed) — so you can
// also log in as these demo customers to see the customer-facing account page.
const PWHASH = "$2b$10$GTFPOI5Go/p7IFCJa4Njwe/4gidArRwkXGrdCwLR6k6H1VNjHivXa";

const now = new Date();
const in30d = new Date(now.getTime() + 30 * 24 * 3600 * 1000);

const j = (o) => JSON.stringify(o);

async function main() {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: resolveDatabaseUrl(process.env.DATABASE_URL) });
  try {
    // 1) wipe prior demo rows (orders -> subs -> customers), demo-tagged only.
    const demoCustomers = await prisma.customer.findMany({
      where: { email: { contains: DOMAIN } }, select: { id: true },
    });
    const ids = demoCustomers.map((c) => c.id);
    if (ids.length) {
      await prisma.planOrder.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.subscription.deleteMany({ where: { customerId: { in: ids } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
      console.log(`cleared ${ids.length} prior demo customer(s)`);
    }

    // 2) Customer A — the showcase (bind line, 2 products, one UNBOUND + GRANT order).
    const a = await prisma.customer.create({
      data: {
        email: `hub${DOMAIN}`, passwordHash: PWHASH, emailVerified: true,
        displayName: "Demo Hub", referralCode: `DEMO-HUB`, status: "ACTIVE",
      },
    });
    const s1Config = {
      line: "bind",
      products: ["anthropic", "codex"],
      items: [{ product: "anthropic", level: "max-20x" }, { product: "codex", level: "plus" }],
      levels: { anthropic: "max-20x", codex: "plus" },
      bindings: { anthropic: 9001, codex: 0 },
      weight: 4, deviceLimit: 3, windowMs: 18000000,
    };
    const s1 = await prisma.subscription.create({
      data: {
        customerId: a.id, status: "ACTIVE", startsAt: now, expiresAt: in30d,
        productEntitlements: j(["anthropic", "codex"]),
        levels: j(s1Config.levels), bindings: j(s1Config.bindings),
        config: j(s1Config), weight: 4, deviceLimit: 3,
        backingKeyValue: "demo-key-s1",
      },
    });
    await prisma.planOrder.create({
      data: {
        customerId: a.id, subscriptionId: s1.id, amountCents: 0, payChannel: "GRANT",
        outTradeNo: "DEMO-GRANT-1", status: "PAID", paidAt: now, expiresAt: now,
        selection: j({ line: "bind", items: s1Config.items, shareUsers: 2, deviceLimit: 3 }),
        config: j(s1Config),
      },
    });
    // a superseded/cancelled older sub on the same customer (shows 已取消, frees seat)
    const s3Config = {
      line: "bind", products: ["anthropic"], items: [{ product: "anthropic", level: "pro" }],
      levels: { anthropic: "pro" }, bindings: { anthropic: 9002 }, weight: 1, deviceLimit: 1, windowMs: 18000000,
    };
    const s3 = await prisma.subscription.create({
      data: {
        customerId: a.id, status: "CANCELLED", startsAt: now, expiresAt: in30d,
        productEntitlements: j(["anthropic"]), levels: j(s3Config.levels),
        bindings: j(s3Config.bindings), config: j(s3Config), weight: 1, deviceLimit: 1,
        backingKeyValue: "demo-key-s3",
      },
    });
    await prisma.planOrder.create({
      data: {
        customerId: a.id, subscriptionId: s3.id, amountCents: 0, payChannel: "GRANT",
        outTradeNo: "DEMO-GRANT-2", status: "PAID", paidAt: now, expiresAt: now,
        selection: j({ line: "bind", items: s3Config.items }), config: j(s3Config),
      },
    });

    // 3) Customer B — paid pool-line order (shows 退款 action).
    const b = await prisma.customer.create({
      data: {
        email: `paid${DOMAIN}`, passwordHash: PWHASH, emailVerified: true,
        displayName: "Demo Paid", referralCode: `DEMO-PAID`, status: "ACTIVE",
      },
    });
    const s2Config = { line: "pool", products: ["anthropic"], usageTier: "large", weight: 1, deviceLimit: 1, windowMs: 18000000 };
    const s2 = await prisma.subscription.create({
      data: {
        customerId: b.id, status: "ACTIVE", startsAt: now, expiresAt: in30d,
        productEntitlements: j(["anthropic"]), config: j(s2Config), weight: 1, deviceLimit: 1,
        backingKeyValue: "demo-key-s2",
      },
    });
    await prisma.planOrder.create({
      data: {
        customerId: b.id, subscriptionId: s2.id, amountCents: 5900, payChannel: "ALIPAY",
        outTradeNo: "DEMO-ALI-1", status: "PAID", paidAt: now, expiresAt: now,
        selection: j({ line: "pool", products: ["anthropic"], usageTier: "large", deviceLimit: 1 }),
        config: j(s2Config),
      },
    });

    console.log("✔ demo seeded:");
    console.log(`  customer A  hub${DOMAIN}  (sub ${s1.id})  ← bind anthropic+codex, codex UNBOUND, GRANT order`);
    console.log(`  customer B  paid${DOMAIN} (sub ${s2.id})  ← pool, paid ¥59 order`);
    console.log(`  deep link:  /console/subscriptions?sub=${s1.id}`);
    console.log(`  login:      admin@gfa.local / admin123 (console)  |  demo customers use admin123 too`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
