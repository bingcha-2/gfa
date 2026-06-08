// 卡密管理页(rosetta-keys)前端类型 —— 严格对齐 apps/api 的 AccessKeyService.listAccessKeys
// 返回形状以及 updateAccessKey/setAccessKeyBindings 的入参。重构进行中,这里是基础组件
// (model-limits-editor / product-binding-manager / card-config-form)共用的类型真相源。
//
// 后端复合桶键恒为 "<product>-<family>",例如:
//   antigravity-gemini | antigravity-claude | codex-gpt | anthropic-claude
// label 形如 "Antigravity · Claude"。

/** 卡类型:pool = 万能卡(不绑任何产品 → 自动开放全部产品);bound = 绑定卡(逐产品绑号)。 */
export type CardType = "pool" | "bound";

/** 产品轴:卡按产品出售/绑定。 */
export type Product = "codex" | "antigravity" | "anthropic";

/**
 * 单个模型桶的额度摘要(给「额度」列与「模型限额」编辑器)。
 * - pool 卡:列全部产品桶;bound 卡:仅列已绑产品对应的桶。
 * - limit=0 表示无限/未设(bucketLimits 覆盖值)。
 */
export interface AccessKeyBucket {
  /** 复合桶键 "<product>-<family>",如 "antigravity-claude" | "codex-gpt"。 */
  bucket: string;
  /** 人类可读标签,如 "Antigravity · Claude"。 */
  label: string;
  /** 当前窗口已用(计费 token)。 */
  used: number;
  /** bucketLimits 覆盖值;0 = 无限/未设。 */
  limit: number;
}

/** 绑定卡的单条绑定明细(accountId→email 由后端 join 账号池文件得到)。 */
export interface AccessKeyBindingDetail {
  /** 产品:"codex" | "antigravity" | "anthropic"。 */
  product: string;
  /** 账号 id(>0)。 */
  accountId: number;
  /** join 自对应账号池文件;查不到为 ""。 */
  accountEmail: string;
}

/**
 * 绑定卡的 fair-share 份额信息(本期后端可能省略,故整体可选)。
 * fraction = 本卡在所绑账号原生配额中分到的比例(0..1)。
 */
export interface AccessKeyFairShare {
  fraction: number;
}

/**
 * listAccessKeys() 返回 { ok: true, keys: AccessKeyListItem[] } 中的单卡形状。
 * 字段与后端 BACKEND_SHAPE 一一对应;fairShare 本期后端可能不下发(可选)。
 */
export interface AccessKeyListItem {
  // ── 标识 / 展示 ──
  id: string;
  name: string;
  /** 完整卡密(仅创建/特定接口返回;列表通常只给掩码)。 */
  fullKey: string;
  /** 掩码后的卡密。 */
  key: string;
  status: string; // "active" | "disabled" | "expired" | ...
  provider: string;

  // ── 卡类型与额度摘要(重设计新增)──
  cardType: CardType;
  /** pool 卡列全部产品桶;bound 卡只列已绑产品的桶。 */
  buckets: AccessKeyBucket[];
  /** pool 卡恒为 []。 */
  bindingsDetail: AccessKeyBindingDetail[];
  /** 绑定卡 fair-share 份额(后端可能省略)。 */
  fairShare?: AccessKeyFairShare;

  // ── 绑定 / 配额相关 ──
  /** { product: accountId };{} = 万能卡。 */
  bindings: Record<string, number>;
  /** 每桶 token 上限(0/缺省 = 无限)。 */
  bucketLimits: Record<string, number>;
  /** 份额 1..capacity(默认 1;updateAccessKey 可改)。 */
  weight: number;
  /** 账号份额容量(全局常量;绑定卡「份额 n/N」的 N)。 */
  shareCapacity: number;
  boundAccountId: number;

  // ── 用量 / 有效期 ──
  totalRequests: number;
  totalTokensUsed: number;
  /** 当前窗口总用量(整卡)。 */
  recentWindowTokens: number;
  windowMs: number;
  weeklyTokenLimit: number;
  durationMs: number;
  /** ISO;"" = 永不过期。 */
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string;

  // ── 会话 / 设备 ──
  sessionClientId: string;
  sessionExpiresAt: string;

  // ── 监控(部分接口提供)──
  anomalyCount?: number;
}

/** 可绑定账号(用于产品绑定下拉),对齐 rosetta-accounts 各池 API + toBindableAccounts。 */
export interface BindableAccount {
  /** 所属产品:"codex" | "antigravity" | "anthropic"。 */
  provider: string;
  id: number;
  email: string;
  /** 已用份额(该账号上所有绑定卡的 weight 之和)。 */
  usedShares: number;
  /** 每账号总份额(份),默认 8。 */
  shareCapacity: number;
  /** 会员等级(planType)。 */
  planType?: string;
}

/**
 * card-config-form 的受控值:新增与编辑共用。
 * - bindings 为空 => 万能卡;非空 => 绑定卡(仅绑定产品可用)。
 * - bucketLimits 留空(无该键或 0)= 该模型无限。
 */
export interface CardConfigValue {
  /** 卡类型:显式状态(万能/绑定),不再由 bindings 是否为空隐式推导。
   *  pool=万能(全产品开放,bindings 必为 {});bound=绑定(逐产品绑号)。 */
  cardType: CardType;
  /** 名称/备注(可选)。 */
  name: string;
  /** 有效期数值(配合 durationUnit)。 */
  durationValue: string;
  /** 有效期单位:小时/天。 */
  durationUnit: "h" | "d";
  /** 限流窗口数值(配合 windowUnit)。 */
  windowValue: string;
  /** 限流窗口单位:小时/天。 */
  windowUnit: "h" | "d";
  /** 整张绑定映射 { product: accountId };{} = 万能卡。 */
  bindings: Record<string, number>;
  /** 卡级份额 1..8(作用于本卡所有绑定)。 */
  weight: number;
  /** 每桶 token 上限 { bucket: number };缺省/0 = 无限。 */
  bucketLimits: Record<string, number>;
}

/** card-config-form 的 onChange:接收部分字段补丁(受控合并)。 */
export type CardConfigPatch = Partial<CardConfigValue>;
