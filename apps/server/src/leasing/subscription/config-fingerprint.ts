// config-fingerprint.ts — 同配置续费去重的判断键(spec §8,纯函数无 IO)。
// 「同配置再买」= 命中一条 config 等价的 ACTIVE 订阅 → 延长 expiresAt,不新建。
//
// 指纹覆盖「购买意图」(用户选了什么),故意排除两类字段:
//  - bindings:座位分配的「结果」,非用户选配。两笔同配置购买分到不同号也算同配置
//    (续费应复用,不因分配差异而新建)。
//  - windowMs:窗口锁死、不向用户暴露(spec §3.2),不参与等价判断。
//
// per-line 规范化:号池比 用量上限(bucketLimits + weeklyTokenLimit);绑定比
// levels(每产品等级)+ weight(共享人数)。两线共有:排序后 products + deviceLimit。

/** 把对象按 key 升序规范成稳定字符串(键序无关 + 值规范),供指纹拼接。 */
function canonicalObject(obj: unknown): string {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "{}";
  const entries = Object.entries(obj as Record<string, unknown>)
    .map(([k, v]) => [k, v] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/** 排序后的产品列表(集合等价:顺序无关)。 */
function canonicalProducts(products: unknown): string {
  const arr = Array.isArray(products) ? products.map((p) => String(p)) : [];
  return JSON.stringify([...arr].sort());
}

/**
 * 配置指纹:同一指纹 = 购买意图等价(续费可复用延长)。缺字段不抛错,产出稳定串。
 */
export function configFingerprint(config: Record<string, any>): string {
  const line = String(config?.line || "");
  const products = canonicalProducts(config?.products);
  const deviceLimit = Number(config?.deviceLimit) || 0;

  if (line === "bind") {
    // 绑定线:等级(per-product)+ 份额(共享人数);bindings 不进(分配结果)。
    const levels = canonicalObject(config?.levels);
    const weight = Number(config?.weight) || 0;
    return `bind|${products}|dev=${deviceLimit}|levels=${levels}|w=${weight}`;
  }

  // 号池(及任何非 bind):用量上限决定档位。
  const bucketLimits = canonicalObject(config?.bucketLimits);
  const weeklyTokenLimit = Number(config?.weeklyTokenLimit) || 0;
  return `pool|${products}|dev=${deviceLimit}|bl=${bucketLimits}|wk=${weeklyTokenLimit}`;
}

/** 两份 config 是否「购买意图等价」(同配置续费去重的判断键)。 */
export function sameConfigFingerprint(a: Record<string, any>, b: Record<string, any>): boolean {
  return configFingerprint(a) === configFingerprint(b);
}
