/**
 * rewash-subscriptions-from-cards.ts —— 按卡密快照「重新洗」订阅绑定(绑定关系写死)。
 *
 * 真相源 = 用户提供的 access-keys.json 快照(下方 CARD_BINDINGS,写死)。不读线上文件:
 * 现网的 bindings 很可能已被早先操作清掉,快照才是真相源。
 *
 * 背景:订阅有两个独立字段 ——
 *   · bindings            = 每个产品绑到哪个上游号(如 {anthropic: 8})
 *   · productEntitlements = 该订阅「对外声明开通了哪些产品」;接力的 serves 闸用的是它。
 * 两者不一致(productEntitlements 含了没绑号的 codex/antigravity)→ 这些产品的请求被
 * serves 误命中却没有上游号 → 429「账户所有订阅额度已用尽」/ 409「此卡未开通该服务」。
 *
 * 洗法(选项 A「收敛」):对每张「有真实 bindings」的卡,把同 id 订阅的
 *   · bindings            刷成快照值(卡密原本绑的号)
 *   · productEntitlements 收敛成 bindings 的 key(只声明实际绑了号的产品)
 *   · levels              过滤到这些产品(去掉已移除产品的残留档位)
 *   · config              用 legacyColumnsToConfig 按上面重算(→ line=bind, products=收敛后)
 * 真正的混绑卡(如 {codex,anthropic})两者都保留 —— 它俩都真绑了号。
 *
 * 不碰:号池卡(快照里无真实绑定的卡,静态 bucketLimits 额度)、catalog 订阅(无对应卡 id)、
 *       weight / 用量。幂等:已是目标态的订阅自动跳过。
 *
 * 安全:默认 dry-run,逐条打印「前 → 后」;--apply 才写。写后重启服务(pnpm start:stop &&
 *       start:daemon)让内存订阅按新 config 重载。结尾有覆盖检查:列出「库里有绑定但不在本表」
 *       的订阅,供人工核对(防抄漏)。
 *
 * 用法:
 *   pnpm exec tsx scripts/rewash-subscriptions-from-cards.ts            # dry-run
 *   pnpm exec tsx scripts/rewash-subscriptions-from-cards.ts --apply    # 写入
 */
import { PrismaClient } from "@prisma/client";

import { legacyColumnsToConfig } from "../apps/server/src/leasing/subscription/subscription-config";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

// 卡 id → 原绑定账号(取自用户提供的 access-keys.json 快照,仅含 value>0 的绑定卡,共 55 张)。
// 混绑卡(两个产品都绑了号)保留两者。号池卡(bindings 为空 / 只有 bucketLimits)不在此列。
const CARD_BINDINGS: Record<string, Record<string, number>> = {
  // —— antigravity 绑定卡 ——
  card_mpz94hnk_d78342df: { antigravity: 532 },
  card_mq06w15c_dc57e6f6: { antigravity: 532 },
  card_mq0934eq_b752dbe8: { antigravity: 529 },
  card_mq0aqypk_85551dcd: { antigravity: 529 },
  card_mq2eesjb_ca6b8d06: { antigravity: 531 },
  // —— codex 绑定卡 ——
  card_mqa6paxq_1415346b: { codex: 8 },
  card_mqa6pmzj_8cae5bd6: { codex: 7 },
  card_mqaa8l3r_b1326b22: { codex: 8 },
  card_mqac5xpd_738168ca: { codex: 7 },
  card_mqdevpj1_0e761d21: { codex: 7 },
  card_mqdfdx7v_8eb81f39: { codex: 7 },
  card_mqdhq80y_1b79cec2: { codex: 7 },
  card_mqefyl2m_5f611172: { codex: 8 },
  card_mqefyl2m_158a01a4: { codex: 8 },
  // —— anthropic 绑定卡 ——
  card_mq6n28oz_fb5e5acd: { anthropic: 2 },
  card_mq6ozzim_0bb5ab86: { anthropic: 2 },
  card_mq6u2m1y_57d97695: { anthropic: 5 },
  card_mq6ukwmm_e13a45a5: { anthropic: 8 },
  card_mq7jy9rk_7b066d82: { anthropic: 6 },
  card_mq7jzz9k_b7e7a56f: { anthropic: 5 },
  card_mq7kba6b_5363f5e2: { anthropic: 5 },
  card_mq7prrsl_4a9c8890: { anthropic: 2 },
  card_mq7w7zw2_11c46858: { anthropic: 7 },
  card_mq8tda32_3f3fd0ed: { anthropic: 5 },
  card_mq92o6w9_b75aeed5: { anthropic: 5 },
  card_mq93sdl3_a81ac5da: { anthropic: 14 },
  card_mq945mbn_6ad3966d: { anthropic: 7 },
  card_mq96gwf3_d75c7325: { anthropic: 2 },
  card_mq9eufvt_631b546e: { anthropic: 8 },
  card_mq9eufvu_97e58040: { anthropic: 8 },
  card_mq9fm23a_6ab04ddf: { anthropic: 8 },
  card_mq9g3qk5_e66f67ec: { anthropic: 13 },
  card_mq9jctf4_c0c7a6cb: { anthropic: 9 },
  card_mq9jxkbs_9252ceae: { anthropic: 10 },
  card_mq9kvsfl_2b7098ce: { anthropic: 10 },
  card_mqa82ba7_2289818f: { anthropic: 10 },
  card_mqb3s1sg_f09de6f3: { anthropic: 5 },
  card_mqbz35ib_f3a10e02: { anthropic: 13 },
  card_mqc2sfj7_afdc95ea: { anthropic: 11 },
  card_mqd7re4r_2551b5d9: { anthropic: 8 },
  card_mqdhrb2l_6d1cfa33: { anthropic: 2 },
  card_mqejorly_2da888c2: { anthropic: 12 },
  card_mqejorly_4b289e43: { anthropic: 12 },
  card_mqejorly_e1aa9955: { anthropic: 12 },
  card_mqejorly_9330437d: { anthropic: 12 },
  card_mqejorly_f78178f4: { anthropic: 12 },
  card_mqenr09z_76cb7b1d: { anthropic: 12 },
  card_mqeoshus_361150a2: { anthropic: 11 },
  card_mqetnxol_d62ab272: { anthropic: 11 },
  card_mqexsrqr_2d2c7012: { anthropic: 5 },
  card_mqeyvt1h_e962558f: { anthropic: 10 },
  card_mqf20mse_274e854d: { anthropic: 8 },
  card_mqfcvkr2_d2df34cb: { anthropic: 13 },
  // —— 混绑卡(两个产品都绑了号,收敛后两者都保留)——
  card_mq23mk0w_ab85c294: { codex: 2, antigravity: 531 },
  card_mqc1u7ji_12c867e6: { codex: 8, anthropic: 12 },
};

const sortedObj = (o: Record<string, number>) =>
  JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));
const sortedArr = (a: string[]) => JSON.stringify([...a].sort((x, y) => x.localeCompare(y)));

function realBindings(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [p, v] of Object.entries(raw as Record<string, unknown>)) if (Number(v) > 0) out[p] = Number(v);
  }
  return out;
}

function parseObj(json: string | null): Record<string, any> {
  try {
    const v = JSON.parse(json || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
function parseArr(json: string | null): string[] {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

async function main() {
  console.log(`[rewash] ${APPLY ? "APPLY" : "DRY-RUN"} —— ${Object.keys(CARD_BINDINGS).length} 张绑定卡(写死快照)`);

  let matched = 0,
    changed = 0,
    missing = 0;

  for (const [id, bindings] of Object.entries(CARD_BINDINGS)) {
    const row = await prisma.subscription.findUnique({
      where: { id },
      select: {
        id: true,
        config: true,
        productEntitlements: true,
        bucketLimits: true,
        bindings: true,
        levels: true,
        weight: true,
        deviceLimit: true,
        weeklyTokenLimit: true,
        windowMs: true,
      },
    });
    if (!row) {
      missing++;
      continue; // 该卡没被开成订阅 → 跳过
    }
    matched++;

    // 收敛:productEntitlements = bindings 的 key;levels 过滤到这些产品。
    const boundProducts = Object.keys(bindings).sort((a, b) => a.localeCompare(b));
    const oldLevels = parseObj(row.levels);
    const newLevels: Record<string, string> = {};
    for (const p of boundProducts) if (oldLevels[p] != null) newLevels[p] = oldLevels[p];

    const desiredBindingsJson = sortedObj(bindings);
    const desiredProductsJson = sortedArr(boundProducts);
    const config = legacyColumnsToConfig({
      ...(row as any),
      productEntitlements: desiredProductsJson,
      bindings: desiredBindingsJson,
      levels: JSON.stringify(newLevels),
    });
    const desiredConfigJson = JSON.stringify(config);

    const haveBindings = sortedObj(realBindings(parseObj(row.bindings)));
    const haveProducts = sortedArr(parseArr(row.productEntitlements));
    if (
      haveBindings === desiredBindingsJson &&
      haveProducts === desiredProductsJson &&
      (row.config || "") === desiredConfigJson
    ) {
      continue; // 已是目标态,幂等跳过
    }

    changed++;
    const hy = boundProducts.length > 1 ? " [混绑]" : "";
    console.log(`  ${id}${hy}`);
    console.log(`    bindings            ${haveBindings} → ${desiredBindingsJson}`);
    console.log(`    productEntitlements ${haveProducts} → ${desiredProductsJson}  (line=${config.line})`);
    if (APPLY) {
      await prisma.subscription.update({
        where: { id },
        data: {
          bindings: desiredBindingsJson,
          productEntitlements: desiredProductsJson,
          levels: JSON.stringify(newLevels),
          config: desiredConfigJson,
        },
      });
    }
  }

  // 覆盖检查:库里「有真实 bindings 但不在硬编码表」的订阅 —— 可能是抄漏 / 新卡,需人工确认。
  const all = await prisma.subscription.findMany({
    select: { id: true, customerId: true, bindings: true, productEntitlements: true, status: true },
  });
  const gaps = all.filter(
    (s) => Object.keys(realBindings(parseObj(s.bindings))).length > 0 && !(s.id in CARD_BINDINGS),
  );

  console.log(`\n[rewash] 命中订阅 ${matched} 条(${missing} 张卡无对应订阅,跳过);需修正 ${changed} 条。`);
  if (gaps.length) {
    console.log(`\n⚠ 以下 ${gaps.length} 条订阅库里有绑定、但不在硬编码表中(需人工确认,本次未处理):`);
    for (const g of gaps) {
      console.log(
        `    ${g.id}  customer=${g.customerId ?? "?"}  bindings=${sortedObj(realBindings(parseObj(g.bindings)))}  products=${sortedArr(parseArr(g.productEntitlements))}`,
      );
    }
  } else {
    console.log("  覆盖检查:无遗漏(库里所有带绑定的订阅都在本表内)。");
  }
  console.log(
    APPLY
      ? "\n  → 已写入。⚠ 重启服务(pnpm start:stop && start:daemon)让内存订阅重载生效。"
      : "\n  → DRY-RUN,未写入。确认无误后加 --apply。",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
