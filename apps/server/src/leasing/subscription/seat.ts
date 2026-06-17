// 座位占用计数 —— 唯一真相源是订阅(数据库),不再从 access-keys.json 文件数。
// 只看显式 config.line:号池(pool)永不占座位,即便误带 bindings 也不算。
// 对齐 spec §6(无老卡密 / 订阅唯一真相源 / 座位 DB count)。

export interface SubConfig {
  line?: string;
  bindings?: Record<string, number>;
  salesSeatCapacity?: Record<string, number>;
  shareSeats?: number;
  /** 该订阅占的份数(独享=8 … 拼车=1)。缺省按 1 计。 */
  weight?: number;
}

/** 某上游号(accountId)在某产品上已被多少张「绑定订阅」占用。 */
export function countBoundSeats(configs: SubConfig[], accountId: number, product: string): number {
  let n = 0;
  for (const c of configs) {
    if (c.line !== "bind") continue;
    if (Number(c.bindings?.[product]) === accountId) n++;
  }
  return n;
}

/**
 * 某产品下,每个上游号已被「绑定订阅」占用的份额(weight 求和)。座位分配据此判容量,
 * 是去影子后的唯一份额真相源(从 DB 订阅 config,不从 access-keys.json 文件)。
 * 只数 line=bind;号池(即便误带 bindings)不占座位。可传 excludeId 排除自身(resync)。
 */
export function occupiedSharesByAccount(
  configs: Array<SubConfig & { id?: string }>,
  product: string,
  excludeId = "",
): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of configs) {
    if (c.line !== "bind") continue;
    if (excludeId && c.id === excludeId) continue;
    const accountId = Number(c.bindings?.[product]);
    if (!(accountId > 0)) continue;
    const weight = seatWeight(c);
    m.set(accountId, (m.get(accountId) || 0) + weight);
  }
  return m;
}

export function seatWeight(config: Pick<SubConfig, "shareSeats" | "weight">): number {
  return Math.max(1, Math.floor(Number(config.shareSeats ?? config.weight) || 1));
}

export function salesSeatCapacityForProduct(
  config: Pick<SubConfig, "salesSeatCapacity">,
  product: string,
  fallback: number,
): number {
  const raw = Number(config.salesSeatCapacity?.[product]);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  const fallbackCapacity = Math.floor(Number(fallback));
  return Number.isFinite(fallbackCapacity) && fallbackCapacity > 0 ? fallbackCapacity : 8;
}

/**
 * 某产品下,每个上游号已绑的「人数」(= 绑定订阅张数,而非 weight 求和)。选号「人数最多优先」
 * 据此:把拼车塞满、空号留给独享。口径与 occupiedSharesByAccount 完全一致(只数 line=bind、
 * bindings[product] 命中,可 excludeId 排除自身),区别仅是每命中一条 +1 而非 +weight。
 */
export function boundSeatsByAccount(
  configs: Array<SubConfig & { id?: string }>,
  product: string,
  excludeId = "",
): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of configs) {
    if (c.line !== "bind") continue;
    if (excludeId && c.id === excludeId) continue;
    const accountId = Number(c.bindings?.[product]);
    if (!(accountId > 0)) continue;
    m.set(accountId, (m.get(accountId) || 0) + 1);
  }
  return m;
}
