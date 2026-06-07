// One-time product rename migration: product `claude` → `anthropic`.
// Extracted verbatim from rosetta.service.ts (behavior-preserving).
// Idempotent, best-effort, backs up before rewriting.

import * as fs from "fs";
import * as path from "path";

import { readJson, writeJson } from "./store";

/**
 * 一次性产品改名迁移:产品 `claude` → `anthropic`。幂等、尽力而为、写前备份。
 * 1) 账号池文件 `claude-accounts.json` → `anthropic-accounts.json`(仅当新文件不存在且旧文件存在)。
 * 2) `access-keys.json` 每张卡的 `products[]` / `bindings` / `levels` / `accountIds` 里的
 *    产品 key `"claude"` → `"anthropic"`(若已有 anthropic 则去重)。仅当确有 claude key 时改并备份。
 * 不动模型层:模型名 `claude-*`、`modelQuotaFractions.claude`、`claudeHourlyPercent` 等保持不变。
 */
export function migrateClaudeProductToAnthropic(dataDir: string): { renamedPool: boolean; cardsRewritten: number } {
  let renamedPool = false;
  let cardsRewritten = 0;

  try {
    const oldPool = path.join(dataDir, "claude-accounts.json");
    const newPool = path.join(dataDir, "anthropic-accounts.json");
    if (fs.existsSync(oldPool) && !fs.existsSync(newPool)) {
      fs.renameSync(oldPool, newPool);
      renamedPool = true;
    }
  } catch {
    // best-effort: 文件系统异常不阻塞启动
  }

  try {
    const akPath = path.join(dataDir, "access-keys.json");
    if (fs.existsSync(akPath)) {
      const data = readJson(akPath, { keys: [] });
      const keys = Array.isArray(data.keys) ? data.keys : [];
      // 把对象里产品 key "claude" 迁成 "anthropic"(已有 anthropic 则仅删 claude)。
      const renameKey = (obj: any): boolean => {
        if (!obj || typeof obj !== "object" || !("claude" in obj)) return false;
        if (!("anthropic" in obj)) obj.anthropic = obj.claude;
        delete obj.claude;
        return true;
      };
      let changed = false;
      for (const key of keys) {
        let cardChanged = false;
        if (Array.isArray(key.products)) {
          const idx = key.products.indexOf("claude");
          if (idx >= 0) {
            if (key.products.includes("anthropic")) key.products.splice(idx, 1);
            else key.products[idx] = "anthropic";
            cardChanged = true;
          }
        }
        if (renameKey(key.bindings)) cardChanged = true;
        if (renameKey(key.levels)) cardChanged = true;
        if (renameKey(key.accountIds)) cardChanged = true;
        if (cardChanged) {
          changed = true;
          cardsRewritten += 1;
        }
      }
      if (changed) {
        try {
          fs.copyFileSync(akPath, `${akPath}.bak-claude2anthropic-${Date.now()}`);
        } catch {
          // 备份失败不阻塞迁移
        }
        writeJson(akPath, data);
      }
    }
  } catch {
    // best-effort
  }

  return { renamedPool, cardsRewritten };
}
