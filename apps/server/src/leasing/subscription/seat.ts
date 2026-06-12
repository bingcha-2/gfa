// 座位占用计数 —— 唯一真相源是订阅(数据库),不再从 access-keys.json 文件数。
// 只看显式 config.line:号池(pool)永不占座位,即便误带 bindings 也不算。
// 对齐 spec §6(无老卡密 / 订阅唯一真相源 / 座位 DB count)。

export interface SubConfig {
  line?: string;
  bindings?: Record<string, number>;
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
