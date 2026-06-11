/**
 * 校验 app 前端所有 t('key.path') / tr('key.path') 引用的键在简中源里存在
 * (t() 是字符串寻址,tsc 查不出打错的键)。
 *   用法: npx tsx scripts/check-i18n-usage.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../apps/app/frontend/src", import.meta.url).pathname;

const { zhCN } = await import("../apps/app/frontend/src/i18n/locales/zh-CN");

function exists(path: string): boolean {
  let cur: unknown = zhCN;
  for (const part of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string";
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "i18n" || name === "test") continue;
      yield* walk(p);
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.tsx")) {
      yield p;
    }
  }
}

let bad = 0;
let total = 0;
for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\b(?:t|tr)\(\s*'([a-zA-Z0-9_.]+)'/g)) {
    total++;
    if (!exists(m[1])) {
      bad++;
      console.error(`✗ ${file.replace(SRC + "/", "")} → 键不存在: ${m[1]}`);
    }
  }
}
if (bad) {
  console.error(`\n${bad}/${total} 个键引用无效`);
  process.exit(1);
}
console.log(`全部 ${total} 个 t() 键引用有效 ✓`);
