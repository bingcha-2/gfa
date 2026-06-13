#!/usr/bin/env node
/**
 * epay-mock-notify.mjs — 模拟 zhunfu epay **V2**(RSA)的异步回调,本地把「下单 → 开通订阅」
 * 整条链路跑通,无需 ngrok、无需真付款。等价于 zhunfu 确认收款后 GET /api/epay/notify。
 *
 * V2 下回调由「平台私钥」签名、后端用「平台公钥」验签 —— 平台私钥只有 zhunfu 有,本地拿不到。
 * 所以本地模拟必须自备一对【测试密钥对】:把测试公钥临时填进 .env 的 EPAY_PLATFORM_PUBLIC_KEY、
 * 重启后端,再用测试私钥签回调。两步:
 *
 *   1) 生成测试密钥对(一次性):
 *        node scripts/epay-mock-notify.mjs --genkey
 *      → 打印【测试公钥】(填进 .env EPAY_PLATFORM_PUBLIC_KEY,重启后端)和【测试私钥】(下一步用)。
 *
 *   2) 下单拿到 out_trade_no 后,用测试私钥签一个 TRADE_SUCCESS 回调:
 *        EPAY_MOCK_PRIV='<测试私钥>' node scripts/epay-mock-notify.mjs <out_trade_no> <money元> [apiBase]
 *      例: EPAY_MOCK_PRIV="$KEY" node scripts/epay-mock-notify.mjs gfa1739abc... 9.90
 *
 * money 必须等于订单金额(元),否则后端按「金额不符」拒绝。
 * EPAY_PID: 优先环境变量,否则从仓库根 .env 读(回调要带对的 pid)。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── --genkey: 生成一对测试密钥对(裸 base64),供本地模拟回调用 ──
if (process.argv.includes("--genkey")) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const priv = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  console.log("【测试公钥】填进 .env 的 EPAY_PLATFORM_PUBLIC_KEY(本地测完记得换回真平台公钥),然后重启后端:\n");
  console.log(pub);
  console.log("\n【测试私钥】下一步用(别填 .env):\n");
  console.log(priv);
  console.log('\n然后: EPAY_MOCK_PRIV="' + priv.slice(0, 12) + '…" node scripts/epay-mock-notify.mjs <out_trade_no> <money>');
  process.exit(0);
}

/** process.env 优先;缺失则从仓库根 .env 读 EPAY_PID。 */
function loadPid() {
  if (process.env.EPAY_PID) return process.env.EPAY_PID;
  try {
    const text = fs.readFileSync(path.resolve(__dirname, "..", ".env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*EPAY_PID\s*=\s*"?([^"#\s]*)"?/);
      if (m) return m[1];
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** V2 待签名串(剔除 sign/sign_type/空值,key ASCII 升序,k=v&)+ RSA-SHA256(测试私钥)→ base64。 */
function signRSA(params, privB64) {
  const data = Object.entries(params)
    .filter(([k, v]) => v !== "" && v != null && k !== "sign" && k !== "sign_type")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const body = privB64.replace(/[^A-Za-z0-9+/=]/g, "").match(/.{1,64}/g)?.join("\n") ?? "";
  const key = crypto.createPrivateKey({ key: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`, format: "pem" });
  return crypto.sign("sha256", Buffer.from(data, "utf8"), key).toString("base64");
}

const [outTradeNo, money] = process.argv.slice(2);
const apiBase = (process.argv[4] || "http://localhost:3001/api").replace(/\/+$/, "");

if (!outTradeNo || !money) {
  console.error("用法: EPAY_MOCK_PRIV='<测试私钥>' node scripts/epay-mock-notify.mjs <out_trade_no> <money元> [apiBase]");
  console.error("先跑 node scripts/epay-mock-notify.mjs --genkey 生成测试密钥对。");
  process.exit(1);
}

const PRIV = process.env.EPAY_MOCK_PRIV;
const PID = loadPid();
if (!PRIV) {
  console.error("缺 EPAY_MOCK_PRIV(测试私钥)。先 --genkey 生成,把公钥填进 .env 重启后端,再用私钥跑本脚本。");
  process.exit(1);
}
if (!PID) {
  console.error("缺 EPAY_PID(环境变量和 .env 都没读到)");
  process.exit(1);
}

const params = {
  pid: PID,
  trade_no: "mock" + Date.now(), // 平台订单号,随便造
  out_trade_no: outTradeNo,
  type: "alipay",
  name: "mock-plan",
  money,
  trade_status: "TRADE_SUCCESS",
  timestamp: Math.floor(Date.now() / 1000).toString(),
};
params.sign = signRSA(params, PRIV);
params.sign_type = "RSA";

// V2 异步通知是 GET(参数在 query)。
const url = `${apiBase}/epay/notify?${new URLSearchParams(params).toString()}`;
const res = await fetch(url, { method: "GET" });
const txt = (await res.text()).trim();

console.log(`GET ${apiBase}/epay/notify?out_trade_no=${outTradeNo}&money=${money}&pid=${PID}&…`);
console.log(`→ HTTP ${res.status} | body: "${txt}"`);
console.log(
  txt === "success"
    ? "✅ 回调被接受——订单应已 PAID、订阅已开通(去用户中心/数据库确认)"
    : '❌ 被拒——看后端日志 [epay-callback](常见:测试公钥没填进 .env / 没重启 / money 不符 / 订单不存在)',
);
