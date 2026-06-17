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

export function legacySeatFromBucketLimits(bucketLimits: Record<string, unknown> | null | undefined): number {
  const values = Object.values(bucketLimits || {})
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 1);
  const max = values.length ? Math.max(...values) : 0;
  if (max <= 8_000_000) return 1;
  if (max <= 16_000_000) return 2;
  if (max <= 32_000_000) return 4;
  return 8;
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

/**
 * 把一行 DB 订阅解析成 config 对象,用于座位会计 / 选号 / 后台展示。
 * 有显式 config(catalog 下单写入)→ 用它;config 为空 → 从 legacy 列回退
 * (legacyColumnsToConfig)。卡迁移订阅(bind-card)只写 legacy `bindings` 列、config 空,
 * 若只读 config 会把它当「无 line/无 bindings」漏数 —— 份额显示 0/N + 选号超分。
 * 运行时(loadActiveSubscriptions)使用 rowToConfig,这里对齐同一口径。
 */
export function rowToConfig(row: { config?: string | null } & LegacyColumns): Record<string, unknown> {
  const raw = String(row.config || "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* config 损坏 → 回退 legacy 列 */
    }
  }
  return legacyColumnsToConfig(row);
}

/**
 * 下单时按 plan 意图建「初始 config」(座位尚未分配,bindings 还空)。line 由 plan 意图定:
 * 配了 levels(非空)→ 绑定线(bindings 空待分配);否则号池线(卖用量)。与 legacyColumnsToConfig
 * 的区别:后者据已分配的 bindings 反推 line(boot/迁移用),前者据 levels 正推 line(下单用,
 * 那时 bindings 必空,不能靠它推断)。对齐 spec §4.3「line 下单时写定,不靠 bindings 空不空推断」。
 */
export function planColumnsToInitialConfig(sub: LegacyColumns): Record<string, unknown> {
  const products = parseArray(sub.productEntitlements);
  const levels = parseObject(sub.levels);
  const isBind = Object.keys(levels).length > 0;

  if (isBind) {
    return {
      line: "bind",
      products,
      levels,
      bindings: {},
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

export interface SubscriptionRow {
  id: string;
  customerId?: string;
  priority?: number;
  backingKeyValue?: string;
  status: string;
  expiresAt: Date | null;
  config: Record<string, any>;
}

/**
 * 运行时:把订阅(已解析 config)转成限额引擎认的 record(去影子核心)。
 * 只产出配置字段;用量(tokenUsageEvents/窗口)由引擎按 id 从内存窗口存储单独挂载。
 */
export function subscriptionToLimitRecord(sub: SubscriptionRow): Record<string, unknown> {
  const config = sub.config;
  const base: Record<string, unknown> = {
    id: sub.id,
    key: sub.backingKeyValue,
    customerId: sub.customerId,
    priority: sub.priority ?? 0,
    status: sub.status === "ACTIVE" ? "active" : "expired",
    products: config.products,
    windowMs: config.windowMs,
    keyExpiresAt: sub.expiresAt ? sub.expiresAt.toISOString() : undefined,
  };
  if (config.line === "bind") {
    return {
      ...base,
      bindings: config.bindings || {},
      displayBindings: config.displayBindings || config.bindings || {},
      assignmentPolicy: config.assignmentPolicy || "pinned",
      levels: config.levels || {},
      shareSeats: config.shareSeats ?? config.weight,
      shareCapacity: config.shareCapacity ?? 8,
      weight: config.weight ?? config.shareSeats ?? 1,
      bucketLimits: config.bucketLimits || {},
      weeklyBucketLimits: config.weeklyBucketLimits || {},
      ...(config.weeklyTokenLimit == null ? {} : { weeklyTokenLimit: config.weeklyTokenLimit }),
      requiresBinding: true,
    };
  }
  return { ...base, bucketLimits: config.bucketLimits, weeklyTokenLimit: config.weeklyTokenLimit };
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
