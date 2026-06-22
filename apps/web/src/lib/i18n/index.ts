import { DEFAULT_LOCALE, type Locale } from "./config";
import { zhCN, type Dict } from "./dictionaries/zh-CN";
import { en } from "./dictionaries/en";

import type { DeepPartialDict } from "./dictionaries/types";

export type { Dict } from "./dictionaries/zh-CN";
export type { DeepPartialDict } from "./dictionaries/types";
export * from "./config";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 以 base(简中)为骨架深合并 patch;数组整体替换,缺失键回退 base。 */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : (patch as T));
  }
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base)) {
    if (key in patch) {
      out[key] = deepMerge(
        (base as Record<string, unknown>)[key],
        patch[key],
      );
    }
  }
  return out as T;
}

const RAW: Record<Locale, DeepPartialDict> = {
  "zh-CN": zhCN,
  en,
};

/** 简单占位符插值:fmt("v{ver} 更新", { ver: "1.2" }) → "v1.2 更新"。 */
export function fmt(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (m, key) =>
    key in vars ? String(vars[key]) : m,
  );
}

const cache = new Map<Locale, Dict>();

export function getDictionary(locale: Locale): Dict {
  const hit = cache.get(locale);
  if (hit) return hit;
  const merged =
    locale === DEFAULT_LOCALE ? zhCN : deepMerge(zhCN, RAW[locale] ?? {});
  cache.set(locale, merged);
  return merged;
}
