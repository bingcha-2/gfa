/**
 * subscription-scheduler.ts — 账户级订阅优先级接力。
 *
 * leaseToken 拿到当前订阅 record 后,用 record.customerId 列出该账户的所有 ACTIVE
 * 订阅(按 priority 升序),逐个跑只读三道闸预检,选第一个"当前 bucket 还有额度"的。
 * 每个候选订阅用各自的 boundAccountId 做 fair-share 预检 —— 不限定同一上游母号,
 * 所以订阅A(绑母号X)claude 用完能切到订阅B(绑母号Y)。全部用尽返回 null。
 *
 * 无副作用:预检全只读(precheckRecord 用 dryRun、checkFairShare 本就只读)。
 */
import type { AccessKeyRecord, AccessKeyStore } from "../token-server/access-key-store";

type FairShareLike = { checkFairShare(accountId: number, cardId: string, bucket: string): { allowed: boolean } };

type PrecheckOptions = {
  modelKey?: string;
  product?: string;
  alignedResetAt?: number | ((record: any) => number);
  weeklyRatio?: number | ((record: any) => number);
};

export interface FailoverQuery {
  customerId: string;
  providerId: string;
  modelKey: string;
  bucket: string;
  precheckOptions: PrecheckOptions;
}

export interface FailoverResult {
  picked: AccessKeyRecord | null;
  /** picked=null 时,候选中最早恢复时间(全满的 429 retryAfterMs) */
  resetMs?: number;
}

export class SubscriptionScheduler {
  constructor(
    private readonly store: Pick<AccessKeyStore, "listByCustomerSorted" | "precheckRecord" | "boundAccountIdFor">,
    private readonly fairShareTracker: FairShareLike | null,
  ) {}

  /**
   * 按 priority 选第一个"三道闸全过"的订阅 record;全部用尽返回 { picked: null, resetMs }。
   */
  selectForFailover(q: FailoverQuery): FailoverResult {
    const candidates = this.store.listByCustomerSorted(q.customerId);
    let earliestReset = 0;
    for (const cand of candidates) {
      // 产品过滤:只接力能服务当前 provider 的订阅(绑定该产品 or 号池含该产品)
      const serves =
        this.store.boundAccountIdFor(cand, q.providerId) > 0 ||
        (Array.isArray((cand as any).products) && (cand as any).products.includes(q.providerId));
      if (!serves) continue;
      // 闸①② bucketLimits + weekly(只读预检)
      const pre = this.store.precheckRecord(cand, { ...q.precheckOptions, enforceLimit: true });
      if (!pre.allowed) {
        const r = Number(pre.resetMs || 0);
        if (r > 0 && (earliestReset === 0 || r < earliestReset)) earliestReset = r;
        continue;
      }
      // 闸③ fair-share —— 仅当该订阅绑了上游母号(各订阅用各自的 boundAccountId)
      const boundId = this.store.boundAccountIdFor(cand, q.providerId);
      if (boundId > 0 && this.fairShareTracker) {
        const fs = this.fairShareTracker.checkFairShare(boundId, cand.id, q.bucket);
        if (!fs.allowed) continue;
      }
      return { picked: cand };
    }
    return { picked: null, resetMs: earliestReset || undefined };
  }
}
