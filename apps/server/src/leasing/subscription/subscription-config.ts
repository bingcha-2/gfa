// 把老 Subscription 的独立列收敛成单个 config 对象(瘦身 + 去影子的迁移核心)。
// 用途:① 迁移脚本把旧列灌进 config;② 运行时按 config 喂限额引擎。对齐 spec §4.2 / §12。

export interface LegacyColumns {
  productEntitlements: string;
  bucketLimits: string | null;
  bindings: string | null;
  levels: string | null;
  weight: number;
  deviceLimit: number;
  weeklyTokenLimit: number | null;
  windowMs: number;
}

export function legacyColumnsToConfig(sub: LegacyColumns): Record<string, unknown> {
  const products = parseArray(sub.productEntitlements);
  const bindings = parseObject(sub.bindings);
  // 绑定线 = 至少一个产品锁了真实 accountId(>0);否则号池(占位 0 也算号池)。
  const hasBinding = Object.values(bindings).some((v) => Number(v) > 0);

  if (hasBinding) {
    return {
      line: "bind",
      products,
      levels: parseObject(sub.levels),
      bindings,
      weight: sub.weight,
      deviceLimit: sub.deviceLimit,
      windowMs: sub.windowMs,
    };
  }

  return {
    line: "pool",
    products,
    bucketLimits: parseObject(sub.bucketLimits),
    weeklyTokenLimit: sub.weeklyTokenLimit ?? 0,
    deviceLimit: sub.deviceLimit,
    windowMs: sub.windowMs,
  };
}

function parseArray(json: string | null): string[] {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function parseObject(json: string | null): Record<string, any> {
  try {
    const v = JSON.parse(json || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
