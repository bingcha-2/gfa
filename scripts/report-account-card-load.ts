/**
 * 只读报告:按 access-keys.json,统计每个上游账号(按产品)被多少张卡绑定、加权份额合计,
 * 标出【独占 / 共享 / 超卖】。用来看清「一个号绑太多卡」导致的 fair-share 429(账户所有订阅额度已用尽)。
 *
 * 份额口径:每张卡对某产品的有效 weight = weights[product] ‖ weight(clamp 到 capacity)。
 * 一个账号容量 = ACCOUNT_SHARE_CAPACITY(默认 8)。Σweight > capacity = 超卖(卡互相挤 → 易 429)。
 *
 * 可选 --fix-exclusive:仅对【该账号该产品只有 1 张卡】(真独占)且其 weight < capacity 的,
 *   把 weight 提到 capacity(拿满整账号,消除「独占卡却只拿半额」的误 429)。共享/超卖账号一律不碰。
 *   ⚠ --fix-exclusive 会写 access-keys.json,请先 pnpm start:stop,跑完再 start:daemon。
 *
 * 用法:
 *   只看报告:        pnpm exec tsx scripts/report-account-card-load.ts [--file=<access-keys.json>]
 *   修独占 weight:    pnpm start:stop && pnpm exec tsx scripts/report-account-card-load.ts --fix-exclusive && pnpm start:daemon
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const FIX = process.argv.includes("--fix-exclusive");
const CAPACITY = Math.max(4, Math.min(8, Number(process.env.BCAI_ACCOUNT_SHARE_CAPACITY || 8)));
const PRODUCTS = ["antigravity", "codex", "anthropic"];

function resolvePath(): string {
  const arg = process.argv.find((a) => a.startsWith("--file="));
  if (arg) return arg.slice("--file=".length);
  if (process.env.ROSETTA_DATA_DIR) return path.join(process.env.ROSETTA_DATA_DIR, "access-keys.json");
  const base =
    process.platform === "win32"
      ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "Antigravity", "rosetta", "access-keys.json");
}

function effWeight(card: any, product: string): number {
  const w = Math.floor(Number(card?.weights?.[product] || 0) || Number(card?.weight ?? 1));
  return Number.isFinite(w) && w >= 1 ? Math.min(w, CAPACITY) : 1;
}

function main() {
  const file = resolvePath();
  if (!fs.existsSync(file)) throw new Error(`找不到 access-keys.json:${file}(用 --file= 指定)`);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const cards: any[] = Array.isArray(data.keys) ? data.keys : [];

  // (product, accountId) → 绑它的卡列表
  const groups = new Map<string, { product: string; accountId: number; cards: any[] }>();
  for (const c of cards) {
    if (String(c.status || "active") !== "active") continue;
    const b = c?.bindings && typeof c.bindings === "object" ? c.bindings : {};
    for (const product of PRODUCTS) {
      const acc = Number(b[product] || 0);
      if (acc > 0) {
        const k = `${product}:${acc}`;
        if (!groups.has(k)) groups.set(k, { product, accountId: acc, cards: [] });
        groups.get(k)!.cards.push(c);
      }
    }
  }

  const rows = [...groups.values()]
    .map((g) => ({ ...g, total: g.cards.reduce((s, c) => s + effWeight(c, g.product), 0) }))
    .sort((a, b) => b.total - a.total || b.cards.length - a.cards.length);

  console.log(`容量 capacity=${CAPACITY}/账号。共 ${rows.length} 个 (产品,账号) 绑定组。\n`);
  console.log("产品        账号   卡数  Σweight  状态");
  let oversold = 0, exclusiveFixable = 0;
  for (const r of rows) {
    const flag =
      r.total > CAPACITY ? `超卖(${r.total}/${CAPACITY})`
      : r.cards.length === 1 ? "独占"
      : "共享";
    if (r.total > CAPACITY) oversold++;
    if (r.cards.length === 1 && effWeight(r.cards[0], r.product) < CAPACITY) exclusiveFixable++;
    console.log(`${r.product.padEnd(11)} ${String(r.accountId).padEnd(5)} ${String(r.cards.length).padEnd(5)} ${String(r.total).padEnd(8)} ${flag}`);
  }
  console.log(`\n超卖账号 ${oversold} 个;可「提满 weight」的独占卡 ${exclusiveFixable} 张。`);

  if (!FIX) {
    console.log("\n(只读报告。超卖账号需你把多余卡换绑分流;独占卡可加 --fix-exclusive 提满 weight。)");
    return;
  }

  // --fix-exclusive:仅独占且 weight<capacity → 提到 capacity(写回文件)。
  let fixed = 0;
  for (const r of rows) {
    if (r.cards.length !== 1) continue;
    const card = r.cards[0];
    if (effWeight(card, r.product) >= CAPACITY) continue;
    // 单产品卡 → 直接 weight;多产品卡 → 只提该产品的 weights[product]。
    const boundProducts = PRODUCTS.filter((p) => Number(card?.bindings?.[p] || 0) > 0);
    if (boundProducts.length <= 1) {
      card.weight = CAPACITY;
    } else {
      card.weights = { ...(card.weights || {}), [r.product]: CAPACITY };
    }
    console.log(`  提满:卡 ${card.id} 在 ${r.product} 独占账号 ${r.accountId} → weight ${CAPACITY}`);
    fixed++;
  }
  if (fixed > 0) {
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    console.log(`\n  已写回 ${file}(提满 ${fixed} 张独占卡)。⚠ 务必先 stop 服务再跑、跑完 start。`);
  } else {
    console.log("\n  无可提满的独占卡(独占卡都已是 capacity 或无独占卡)。");
  }
}

main();
