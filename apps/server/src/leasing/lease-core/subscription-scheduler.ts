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

export class SubscriptionScheduler {
  constructor(
    private readonly store: Pick<AccessKeyStore, "listByCustomerSorted" | "precheckRecord" | "boundAccountIdFor">,
    private readonly fairShareTracker: FairShareLike | null,
  ) {}

  /**
   * 按 priority 选第一个"三道闸全过"的订阅 record;全部用尽返回 null。
   */
  selectForFailover(q: FailoverQuery): AccessKeyRecord | null {
    const candidates = this.store.listByCustomerSorted(q.customerId);
    for (const cand of candidates) {
      // 闸①② bucketLimits + weekly(只读预检)
      const pre = this.store.precheckRecord(cand, { ...q.precheckOptions, enforceLimit: true });
      if (!pre.allowed) continue;
      // 闸③ fair-share —— 仅当该订阅绑了上游母号(各订阅用各自的 boundAccountId)
      const boundId = this.store.boundAccountIdFor(cand, q.providerId);
      if (boundId > 0 && this.fairShareTracker) {
        const fs = this.fairShareTracker.checkFairShare(boundId, cand.id, q.bucket);
        if (!fs.allowed) continue;
      }
      return cand;
    }
    return null;
  }
}
