"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { formatDateTime } from "@/lib/format";

export type CodexAccountBenefits = {
  ok: boolean;
  updated?: boolean;
  error?: string;
  subscriptionExpiresAt: string | null;
  subscriptionCheckedAt: number;
  subscriptionError: string;
  resetCredits: { availableCount: number | null; nextExpiresAt: number | null; checkedAt?: number; error: string };
};

export function refreshCodexAccountBenefits(accountId: number, force = false) {
  return apiRequest<CodexAccountBenefits>("rosetta/codex-account-benefits", {
    method: "POST", body: { accountId, force },
  });
}

export function CodexSubscriptionExpiry({
  expiresAt, checkedAt, error,
}: { expiresAt?: string | null; checkedAt?: number; error?: string }) {
  const timestamp = expiresAt ? Date.parse(expiresAt) : NaN;
  const valid = Number.isFinite(timestamp);
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="tabular-nums whitespace-nowrap">
        {valid ? formatDateTime(expiresAt!) : error ? "查询失败" : checkedAt ? "上游未提供" : "未查询"}
      </span>
      {error ? <span className="text-xs text-destructive">{valid ? "刷新失败，显示上次结果" : "请重试"}</span> : null}
      {valid && timestamp <= Date.now() ? <Badge variant="destructive">已到期</Badge> : null}
    </span>
  );
}

export function CodexAccountBenefitsPanel({ accountId, refreshVersion, onUpdated }: {
  accountId: number;
  refreshVersion: number;
  onUpdated?: () => void | Promise<void>;
}) {
  const [data, setData] = useState<CodexAccountBenefits | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const onUpdatedRef = useRef(onUpdated);
  const previousRequest = useRef({ accountId, refreshVersion });
  onUpdatedRef.current = onUpdated;

  useEffect(() => {
    let cancelled = false;
    const force = previousRequest.current.accountId === accountId
      && previousRequest.current.refreshVersion !== refreshVersion;
    previousRequest.current = { accountId, refreshVersion };
    setLoading(true);
    setError("");
    setData(null);
    void (async () => {
      try {
        const result = await refreshCodexAccountBenefits(accountId, force);
        if (cancelled) return;
        if (!result.ok) throw new Error(result.error || "母号信息查询失败");
        setData(result);
        // Updating the list must not turn a successful upstream query into a failure.
        if (result.updated !== false) void Promise.resolve(onUpdatedRef.current?.()).catch(() => {});
      } catch (cause) {
        if (!cancelled) setError(getErrorMessage(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accountId, refreshVersion]);

  return (
    <section aria-label="母号订阅与重置卡" aria-busy={loading} className="flex flex-col gap-2">
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <dt className="text-sm text-muted-foreground">母号订阅到期</dt>
          <dd className="text-sm">
            {loading ? <Skeleton className="h-5 w-40" /> : (
              <CodexSubscriptionExpiry expiresAt={data?.subscriptionExpiresAt}
                checkedAt={data?.subscriptionCheckedAt} error={error || data?.subscriptionError} />
            )}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-sm text-muted-foreground">可用重置卡</dt>
          <dd className="text-sm tabular-nums">
            {loading ? <Skeleton className="h-5 w-20" />
              : error || data?.resetCredits.error ? "查询失败"
                : data?.resetCredits.availableCount == null ? "未知" : `${data.resetCredits.availableCount} 次`}
          </dd>
          {!loading && data?.resetCredits.nextExpiresAt ? (
            <dd className="text-xs text-muted-foreground">最近到期：{formatDateTime(new Date(data.resetCredits.nextExpiresAt * 1000).toISOString())}</dd>
          ) : null}
          {!loading && data?.resetCredits.checkedAt ? (
            <dd className="text-xs text-muted-foreground">查询时间：{formatDateTime(new Date(data.resetCredits.checkedAt).toISOString())}</dd>
          ) : null}
        </div>
      </dl>
      {!loading && (error || data?.subscriptionError || data?.resetCredits.error) ? (
        <Alert variant="destructive">
          <AlertDescription>{error || [data?.subscriptionError, data?.resetCredits.error].filter(Boolean).join("；")}</AlertDescription>
        </Alert>
      ) : null}
      {!loading && data?.subscriptionCheckedAt ? (
        <p className="text-xs text-muted-foreground">订阅查询时间：{formatDateTime(new Date(data.subscriptionCheckedAt).toISOString())}</p>
      ) : null}
    </section>
  );
}
