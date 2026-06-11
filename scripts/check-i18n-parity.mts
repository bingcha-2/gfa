/**
 * i18n 键齐全性校验:每个语言文件的键路径必须与简中源完全一致(双向)。
 * 同时校验 {placeholder} 集合一致、数组长度一致。
 *   用法: npx tsx scripts/check-i18n-parity.ts
 */

export {};

const WEB = "../apps/web/src/lib/i18n/dictionaries";
const APP = "../apps/bcai-wails/frontend/src/i18n/locales";

const LOCALES: Array<[string, string]> = [
  ["zh-TW", "zhTW"],
  ["en", "en"],
  ["ja", "ja"],
  ["ko", "ko"],
  ["es", "es"],
  ["fr", "fr"],
  ["de", "de"],
  ["vi", "vi"],
];

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function flatten(node: unknown, prefix: string, out: Map<string, unknown>) {
  if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else {
    out.set(prefix, node);
  }
}

function placeholders(s: string): string {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
}

async function check(surface: string, dir: string, sourceExport: string) {
  const src = (await import(`${dir}/zh-CN`)) as Record<string, Obj>;
  const base = new Map<string, unknown>();
  flatten(src[sourceExport], "", base);

  let failures = 0;
  for (const [file, exp] of LOCALES) {
    const mod = (await import(`${dir}/${file}`)) as Record<string, Obj>;
    const dict = mod[exp];
    if (!dict) {
      console.error(`✗ [${surface}/${file}] 导出名 ${exp} 不存在`);
      failures++;
      continue;
    }
    const flat = new Map<string, unknown>();
    flatten(dict, "", flat);

    const missing = [...base.keys()].filter((k) => !flat.has(k));
    const extra = [...flat.keys()].filter((k) => !base.has(k));
    const phMismatch: string[] = [];
    const arrMismatch: string[] = [];

    for (const [k, v] of flat) {
      const bv = base.get(k);
      if (typeof v === "string" && typeof bv === "string") {
        if (placeholders(v) !== placeholders(bv)) phMismatch.push(k);
      }
      if (Array.isArray(v) && Array.isArray(bv) && v.length !== bv.length) {
        arrMismatch.push(k);
      }
    }

    if (missing.length || extra.length || phMismatch.length || arrMismatch.length) {
      failures++;
      console.error(`✗ [${surface}/${file}]`);
      if (missing.length) console.error(`    缺失 ${missing.length} 键: ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? " …" : ""}`);
      if (extra.length) console.error(`    多余 ${extra.length} 键: ${extra.slice(0, 12).join(", ")}${extra.length > 12 ? " …" : ""}`);
      if (phMismatch.length) console.error(`    占位符不一致: ${phMismatch.slice(0, 12).join(", ")}`);
      if (arrMismatch.length) console.error(`    数组长度不一致: ${arrMismatch.join(", ")}`);
    } else {
      console.log(`✓ [${surface}/${file}] ${flat.size} 键全部对齐`);
    }
  }
  return failures;
}

const f1 = await check("web", WEB, "zhCN");
const f2 = await check("app", APP, "zhCN");
if (f1 + f2 > 0) {
  console.error(`\n共 ${f1 + f2} 个语言文件未通过校验`);
  process.exit(1);
}
console.log("\n全部语言文件键齐全 ✓");
