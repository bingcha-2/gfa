#!/usr/bin/env node
/**
 * epay-mock-notify.mjs — 模拟 彩虹易支付 的异步回调，本地把「下单 → 开通订阅」整条链路跑通，
 * 无需 ngrok、无需真付款。等价于 epay 服务器确认收款后 POST /api/epay/notify。
 *
 * 用法:
 *   node scripts/epay-mock-notify.mjs <out_trade_no> <money元> [apiBase]
 *   例:  node scripts/epay-mock-notify.mjs gfa1739abc... 9.90
 *
 * 步骤: 先在用户中心下单拿到 out_trade_no（订单号），再用本脚本喂一个签名正确的
 * TRADE_SUCCESS 回调。money 必须等于订单金额（元），否则后端按「金额不符」拒绝。
 *
 * EPAY_KEY / EPAY_PID: 优先读环境变量，否则从仓库根 .env 解析。
 * 签名算法与 apps/server/src/leasing/account/billing/epay.sign.ts 完全一致。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** process.env 优先；缺失则从仓库根 .env 读 EPAY_KEY / EPAY_PID。 */
function loadEpayEnv() {
  const env = { EPAY_KEY: process.env.EPAY_KEY, EPAY_PID: process.env.EPAY_PID };
  if (env.EPAY_KEY && env.EPAY_PID) return env;
  try {
    const text = fs.readFileSync(path.resolve(__dirname, "..", ".env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(EPAY_KEY|EPAY_PID)\s*=\s*"?([^"#\s]*)"?/);
      if (m && !env[m[1]]) env[m[1]] = m[2];
    }
  } catch {
    /* 没 .env 就算了，下面会报缺值 */
  }
  return env;
}

/** 与 epay.sign.ts signParams 一致：过滤空值与 sign/sign_type，按键升序，k=v&… 拼接 + KEY，md5 小写。 */
function signParams(params, key) {
  const qs = Object.entries(params)
    .filter(([k, v]) => v !== "" && v != null && k !== "sign" && k !== "sign_type")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return crypto.createHash("md5").update(qs + key, "utf8").digest("hex").toLowerCase();
}

const [outTradeNo, money] = process.argv.slice(2);
const apiBase = (process.argv[4] || "http://localhost:3001/api").replace(/\/+$/, "");

if (!outTradeNo || !money) {
  console.error("用法: node scripts/epay-mock-notify.mjs <out_trade_no> <money元> [apiBase]");
  process.exit(1);
}

const { EPAY_KEY, EPAY_PID } = loadEpayEnv();
if (!EPAY_KEY || !EPAY_PID) {
  console.error("缺 EPAY_KEY / EPAY_PID（环境变量和 .env 都没读到）");
  process.exit(1);
}

const body = {
  pid: EPAY_PID,
  trade_no: "mock" + Date.now(), // epay 侧交易号，随便造
  out_trade_no: outTradeNo,
  type: "alipay",
  name: "mock-plan",
  money,
  trade_status: "TRADE_SUCCESS",
};
body.sign = signParams(body, EPAY_KEY);
body.sign_type = "MD5";

const url = `${apiBase}/epay/notify`;
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
});
const txt = (await res.text()).trim();

console.log(`POST ${url}`);
console.log(`out_trade_no=${outTradeNo} money=${money} pid=${EPAY_PID}`);
console.log(`→ HTTP ${res.status} | body: "${txt}"`);
console.log(
  txt === "success"
    ? "✅ 回调被接受——订单应已 PAID、订阅已开通（去用户中心/数据库确认）"
    : '❌ 被拒绝——看后端日志 [epay-callback]（常见：money 与订单金额不符 / KEY 不对 / 订单不存在）',
);
