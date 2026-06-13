#!/usr/bin/env node
/**
 * epay-diagnose.mjs — 诊断 zhunfu epay V2(RSA)密钥配置。
 *
 * 本商户走 V2 RSA:下单用【商户私钥】签名,回调用【平台公钥】验签。本脚本做「本地、零对外」
 * 的密钥健康检查 —— 私钥/公钥能否被 node 加载、私钥能否签出样例签名,用来快速定位
 * 「.env 私钥/公钥没填 / 格式错 / 多空格 / 私钥公钥填反」这类导致下单签名失败的配置问题。
 *
 * 注意:商户私钥与平台公钥【不是一对】(私钥是你的、公钥是平台的),本地无法互验配对;
 * 配对由 zhunfu 在下单/回调时校验。本脚本只验证两者各自「格式有效、能用」。
 *
 * 用法: node scripts/epay-diagnose.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const env = {};
  try {
    const text = fs.readFileSync(path.resolve(__dirname, "..", ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
      if (!m) continue;
      let v = m[2].replace(/^\s+/, "");
      const q = v[0];
      if (q === '"' || q === "'" || q === "`") {
        const e = v.indexOf(q, 1);
        v = e > 0 ? v.slice(1, e) : v.slice(1);
      } else {
        const h = v.indexOf("#");
        if (h >= 0) v = v.slice(0, h);
        v = v.trim();
      }
      env[m[1]] = v;
    }
  } catch (e) {
    console.error("读 .env 失败:", e.message);
    process.exit(1);
  }
  return env;
}

function toPem(b64, label) {
  // 只保留 base64 字符:容忍首尾字面引号 / 空白 / 换行(与 epay.sign.ts 一致)。
  const body = b64.replace(/[^A-Za-z0-9+/=]/g, "").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

const env = loadEnv();
const PID = env.EPAY_PID || "";
const PRIV = env.EPAY_MERCHANT_PRIVATE_KEY || "";
const PUB = env.EPAY_PLATFORM_PUBLIC_KEY || "";
const BASE = (env.EPAY_API_BASE || "").replace(/\/+$/, "");
const ok = (b) => (b ? "✓" : "✗");

console.log("=== epay V2(RSA)配置诊断(本地,零对外,不泄密钥明文)===");
console.log("EPAY_PID                  :", PID || "(空 ✗)");
console.log("EPAY_API_BASE             :", BASE || "(空 ✗)", BASE ? `→ 提交接口 ${BASE}/api/pay/submit` : "");

// 商户私钥:能加载 + 能签名 → 可用于下单。
let privOk = false;
let sampleSign = "";
if (!PRIV) {
  console.log("EPAY_MERCHANT_PRIVATE_KEY :", "(空 ✗) — 下单签不出,支付不可用");
} else {
  try {
    const key = crypto.createPrivateKey({ key: toPem(PRIV, "PRIVATE KEY"), format: "pem" });
    sampleSign = crypto.sign("sha256", Buffer.from("money=1.00&pid=" + PID, "utf8"), key).toString("base64");
    privOk = true;
    console.log("EPAY_MERCHANT_PRIVATE_KEY :", ok(true), `有效(${PRIV.length} 字符,能签名)`);
  } catch (e) {
    console.log("EPAY_MERCHANT_PRIVATE_KEY :", ok(false), "无法加载 —", e.message.split("\n")[0]);
    console.log("   → 多半没填 / 漏字符 / 带空格 / 误填成公钥。重新从后台复制【商户私钥】。");
  }
}

// 平台公钥:能加载 → 可用于回调验签。
let pubOk = false;
if (!PUB) {
  console.log("EPAY_PLATFORM_PUBLIC_KEY  :", "(空 ✗) — 回调一律 fail-closed 拒绝,订单永不开通");
} else {
  try {
    crypto.createPublicKey({ key: toPem(PUB, "PUBLIC KEY"), format: "pem" });
    pubOk = true;
    console.log("EPAY_PLATFORM_PUBLIC_KEY  :", ok(true), `有效(${PUB.length} 字符)`);
  } catch (e) {
    console.log("EPAY_PLATFORM_PUBLIC_KEY  :", ok(false), "无法加载 —", e.message.split("\n")[0]);
    console.log("   → 重新从后台复制【平台公钥】。");
  }
}

console.log();
if (PID && BASE && privOk && pubOk) {
  console.log("✓ 配置就绪。重启后端后下单,签名应被 zhunfu 接受。样例签名:", sampleSign.slice(0, 16) + "…");
} else {
  console.log("✗ 配置不完整 —— 按上面标 ✗ 的项修 .env 后重启后端。");
}
