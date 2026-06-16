/**
 * 把订阅的绑定刷回「卡密原本绑定的账号」。
 *
 * 绑定关系来源 = 用户提供的 access-keys.json 快照(下方 CARD_BINDINGS,写死)。
 * 之所以写死而非读现网文件:现网的 bindings 很可能已被早先操作清掉,快照才是真相源。
 *
 * 规则:带绑定的卡 = 绑定卡。订阅刷成 line=bind + 原 bindings → 运行时只服务所绑产品,
 *       codex/antigravity 等未绑产品自动 409。号池卡(无绑定)不在此列,不处理。
 *
 * 做什么:对 CARD_BINDINGS 里每个卡 id,若 DB 存在同 id 的订阅(卡迁移订阅,ID 连续),
 *         把它的 bindings 刷成快照值,并用 legacyColumnsToConfig 重算 config(→ bind)。
 *         只改 bindings/config;不动 productEntitlements/bucketLimits/用量。catalog 订阅不碰。
 *
 * 安全:默认 dry-run,--apply 才写;写后重启服务(pnpm start:stop && start:daemon)让内存重载。
 * 用法:pnpm exec tsx scripts/sync-subscription-bindings-from-cards.ts [--apply]
 */
import { PrismaClient } from "@prisma/client";

import { legacyColumnsToConfig } from "../apps/server/src/leasing/subscription/subscription-config";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

// 卡 id → 原绑定账号(取自用户提供的 access-keys.json 快照,仅含 value>0 的绑定卡)。
const CARD_BINDINGS: Record<string, Record<string, number>> = {
  card_mpz94hnk_d78342df: { antigravity: 532 },
  card_mq06w15c_dc57e6f6: { antigravity: 532 },
  card_mq0934eq_b752dbe8: { antigravity: 529 },
  card_mq0aqypk_85551dcd: { antigravity: 529 },
  card_mq23mk0w_ab85c294: { codex: 2, antigravity: 531 },
  card_mq2eesjb_ca6b8d06: { antigravity: 531 },
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
  card_mqa6paxq_1415346b: { codex: 8 },
  card_mqa6pmzj_8cae5bd6: { codex: 7 },
  card_mqa82ba7_2289818f: { anthropic: 10 },
  card_mqaa8l3r_b1326b22: { codex: 8 },
  card_mqac5xpd_738168ca: { codex: 7 },
  card_mqb3s1sg_f09de6f3: { anthropic: 5 },
  card_mqbz35ib_f3a10e02: { anthropic: 13 },
  card_mqc1u7ji_12c867e6: { codex: 8, anthropic: 12 },
  card_mqc2sfj7_afdc95ea: { anthropic: 11 },
  card_mqd7re4r_2551b5d9: { anthropic: 8 },
  card_mqdevpj1_0e761d21: { codex: 7 },
  card_mqdfdx7v_8eb81f39: { codex: 7 },
  card_mqdftmxv_a47ba1c1: { anthropic: 2 },
  card_mqdhq80y_1b79cec2: { codex: 7 },
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
};

const sortedJson = (o: Record<string, number>) =>
  JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));

function normBindings(json: string | null): Record<string, number> {
  try {
    const b = JSON.parse(String(json || "{}")) || {};
    const out: Record<string, number> = {};
    for (const [p, v] of Object.entries(b)) if (Number(v) > 0) out[p] = Number(v);
    return out;
  } catch {
    return {};
  }
}

async function main() {
  console.log(`[sync] ${APPLY ? "APPLY" : "DRY-RUN"} —— 按快照刷新订阅绑定(${Object.keys(CARD_BINDINGS).length} 张绑定卡)`);
  let matched = 0, changed = 0, missing = 0;
  for (const [id, bindings] of Object.entries(CARD_BINDINGS)) {
    const row = await prisma.subscription.findUnique({
      where: { id },
      select: {
        id: true, config: true,
        productEntitlements: true, bucketLimits: true, bindings: true, levels: true,
        weight: true, deviceLimit: true, weeklyTokenLimit: true, windowMs: true,
      },
    });
    if (!row) { missing++; continue; } // 该卡没有对应订阅(未被客户绑定为订阅)→ 跳过
    matched++;

    const desiredBindingsJson = sortedJson(bindings);
    const config = legacyColumnsToConfig({ ...(row as any), bindings: desiredBindingsJson });
    const desiredConfigJson = JSON.stringify(config);

    const haveBindings = sortedJson(normBindings(row.bindings));
    if (haveBindings === desiredBindingsJson && (row.config || "") === desiredConfigJson) continue;

    changed++;
    console.log(`  ${id}: bindings ${haveBindings} → ${desiredBindingsJson}  line → ${config.line}`);
    if (APPLY) {
      await prisma.subscription.update({
        where: { id },
        data: { bindings: desiredBindingsJson, config: desiredConfigJson },
      });
    }
  }
  console.log(`\n  命中订阅 ${matched} 条(另有 ${missing} 张卡无对应订阅,跳过);需修正 ${changed} 条。`);
  console.log(APPLY ? "  → 已写入。⚠ 重启服务(pnpm start:stop && start:daemon)生效。" : "  → DRY-RUN,未写入。确认后加 --apply。");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
