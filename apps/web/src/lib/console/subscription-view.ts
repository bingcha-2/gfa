export type SubProductRow = {
  product: string;
  level: string | null;
  accountId: number | null;
  bound: boolean;
  /** 绑定号的邮箱(后端按 accountId 解析回填);未绑定或后端未提供时为 null。 */
  accountEmail: string | null;
};

export type SubscriptionView = {
  line: "bind" | "pool";
  rows: SubProductRow[];
  weight: number;
  deviceLimit: number;
  usageTier: string | null;
};

/** 订阅行:优先用显式 `config`,缺失时回退 legacy 列(对齐后端 rowToConfig)。 */
export type SubscriptionLike = {
  config: string | null;
  productEntitlements?: string | null;
  bindings?: string | null;
  levels?: string | null;
  weight?: number | null;
  deviceLimit?: number | null;
  /** 后端按 accountId 解析的绑定号信息(product → 账号),用于详情面板内联展示邮箱。 */
  boundAccounts?: Record<string, { id: number; email: string | null }> | null;
};

function safeParse(json: string | null | undefined): Record<string, any> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function parseArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * config 空/损坏时从 legacy 列推断 config —— 镜像后端 legacyColumnsToConfig:
 * 至少一个产品锁了真实 accountId(>0)即绑定线,否则号池(占位 0 也算号池)。
 * 卡迁移订阅只写 legacy `bindings` 列、config 空,只读 config 会误判为号池。
 */
function legacyConfig(input: SubscriptionLike): Record<string, any> {
  const products = parseArray(input.productEntitlements);
  const bindings = safeParse(input.bindings) ?? {};
  const weight = input.weight ?? 1;
  const deviceLimit = input.deviceLimit ?? 1;
  const hasBinding = Object.values(bindings).some((v) => Number(v) > 0);
  if (hasBinding) {
    return { line: "bind", products, levels: safeParse(input.levels) ?? {}, bindings, weight, deviceLimit };
  }
  return { line: "pool", products, weight, deviceLimit };
}

export function buildSubscriptionView(input: SubscriptionLike): SubscriptionView {
  const c = safeParse(input.config) ?? legacyConfig(input);

  const products: string[] = Array.isArray(c.products) ? c.products.map(String) : [];
  const line: "bind" | "pool" = c.line === "bind" ? "bind" : "pool";
  const levels = (c.levels && typeof c.levels === "object" ? c.levels : {}) as Record<string, string>;
  const bindings = (c.bindings && typeof c.bindings === "object" ? c.bindings : {}) as Record<string, number>;

  const boundAccounts = input.boundAccounts ?? {};
  const rows: SubProductRow[] = products.map((product) => {
    const accountId = line === "bind" ? Number(bindings[product]) || null : null;
    const bound = line === "bind" && accountId != null && accountId > 0;
    return {
      product,
      level: line === "bind" ? (levels[product] ? String(levels[product]) : null) : null,
      accountId: accountId && accountId > 0 ? accountId : null,
      bound,
      accountEmail: bound ? boundAccounts[product]?.email ?? null : null,
    };
  });

  return {
    line,
    rows,
    weight: Math.max(1, Math.floor(Number(c.weight) || 1)),
    deviceLimit: Math.max(1, Math.floor(Number(c.deviceLimit) || 1)),
    usageTier: line === "pool" && c.usageTier ? String(c.usageTier) : null,
  };
}
