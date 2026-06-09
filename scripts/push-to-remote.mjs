#!/usr/bin/env node
/**
 * scripts/push-to-remote.mjs
 *
 * Reads local Rosetta account pools and card keys, and pushes them to a remote
 * GFA server via HTTP API for incremental synchronization.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Read .env manually
function readEnv() {
  const envPath = path.join(ROOT, ".env");
  const env = {};
  if (!fs.existsSync(envPath)) return env;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const env = readEnv();

// Parse CLI args
const args = parseArgs(process.argv.slice(2));
const SYNC_URL = args.url || env.PEER_SYNC_URL;
const SYNC_TOKEN = args.token || env.ROSETTA_SYNC_TOKEN;

if (!SYNC_URL || !SYNC_TOKEN) {
  console.error("❌ 错误：缺少同步配置参数！");
  console.error("请在 .env 中配置 PEER_SYNC_URL 和 ROSETTA_SYNC_TOKEN");
  console.error("或者通过命令行参数传入：");
  console.error("  node scripts/push-to-remote.mjs --url <api-url> --token <sync-token>");
  process.exit(1);
}

const LOCAL_DIR = process.env.ROSETTA_DATA_DIR || defaultLocalRosettaDir();

console.log(`🔌 目标同步接口: ${SYNC_URL}`);
console.log(`📂 本地数据目录: ${LOCAL_DIR}`);

function readJsonFile(name, fallbackKey) {
  const filePath = path.join(LOCAL_DIR, name);
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return Array.isArray(data[fallbackKey]) ? data[fallbackKey] : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function main() {
  // Read local data
  const accounts = readJsonFile("accounts.json", "accounts");
  const codex = readJsonFile("codex-accounts.json", "accounts");
  const keys = readJsonFile("access-keys.json", "keys");

  console.log(`📊 本地加载数据：`);
  console.log(`  - Gemini (accounts.json):      ${accounts.length} 个账号`);
  console.log(`  - Codex (codex-accounts.json):  ${codex.length} 个账号`);
  console.log(`  - 卡密 (access-keys.json):      ${keys.length} 张卡密`);

  if (accounts.length === 0 && codex.length === 0 && keys.length === 0) {
    console.log("⚠️  本地号池没有可同步的数据，退出同步。");
    process.exit(0);
  }

  const payload = { accounts, codex, keys };

  console.log("🚀 正在向远端推送合并数据...");

  try {
    const res = await fetch(SYNC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sync-Token": SYNC_TOKEN,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errorText || "服务器错误"}`);
    }

    const data = await res.json();
    if (data.success && data.stats) {
      console.log("\n================ 同步数据统计 ================");
      console.log(`🟢 Gemini Pool:      新增 ${data.stats.antigravity.added} 个, 更新凭证 ${data.stats.antigravity.updated} 个, 规避 ID 冲突 ${data.stats.antigravity.collisions} 次`);
      console.log(`🟡 Codex Pool:       新增 ${data.stats.codex.added} 个, 更新凭证 ${data.stats.codex.updated} 个, 规避 ID 冲突 ${data.stats.codex.collisions} 次`);
      console.log(`🔑 卡密号池:           新增卡密 ${data.stats.keys.added} 张 (已在服务端重构映射卡密与账号绑定关系)`);
      console.log("=============================================");
      console.log("🎉 相互同步合并数据完成！远端号池已完成增补。");
    } else {
      console.error("❌ 同步失败，返回了未知的响应结构:", data);
    }
  } catch (err) {
    console.error("❌ 推送失败：", err.message);
    process.exit(1);
  }
}

function parseArgs(argsList) {
  const result = {};
  for (let i = 0; i < argsList.length; i++) {
    const arg = argsList[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = argsList[i + 1];
      if (val && !val.startsWith("--")) {
        result[key] = val;
        i++;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

function defaultLocalRosettaDir() {
  const base =
    process.platform === "win32"
      ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "Antigravity", "rosetta");
}

main();
