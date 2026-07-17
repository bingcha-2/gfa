"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { AlertCircleIcon, PencilIcon, RefreshCwIcon, SaveIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { apiRequest, consoleApiPath, getErrorMessage } from "@/lib/console/client-api";
import { formatDateTime } from "@/lib/format";
import {
  confidenceLabel,
  formatCoverage,
  formatQuotaPercent,
  formatQuotaUsd,
  type QuotaPoolDetail,
  type QuotaPoolScope,
  type QuotaPoolSubscription,
  type QuotaPoolTarget,
} from "./quota-pool-types";

type QuotaEditState = {
  subscriptionId: string;
  fiveHour: string;
  weekly: string;
};

type ParsedQuotaEdit = {
  fiveHour: number;
  weekly: number;
};

function quotaUsage(used: number, limit: number): string {
  if (!(limit > 0)) return "未启用";
  return `${formatQuotaUsd(used)} / ${formatQuotaUsd(limit)}`;
}

function strongestRisk(pool: QuotaPoolDetail): { label: string; scope: QuotaPoolScope } | null {
  const scopes = [
    { label: "5 小时", scope: pool.fiveHour },
    { label: "每周", scope: pool.weekly },
  ].filter((item) => item.scope.shortfallUsd > 0);
  return scopes.sort((a, b) => b.scope.shortfallUsd - a.scope.shortfallUsd)[0] || null;
}

function parseQuotaEdit(edit: QuotaEditState): { value: ParsedQuotaEdit | null; error: string } {
  const fiveHour = Number(edit.fiveHour);
  const weekly = Number(edit.weekly);
  if (!edit.fiveHour.trim() || !edit.weekly.trim() || !Number.isFinite(fiveHour) || !Number.isFinite(weekly)) {
    return { value: null, error: "请输入有效的美元额度" };
  }
  if (fiveHour < 0 || weekly < 0) return { value: null, error: "额度不能小于 0" };
  if (fiveHour === 0 && weekly === 0) return { value: null, error: "5 小时和每周额度不能同时为 0" };
  return { value: { fiveHour, weekly }, error: "" };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function AccountQuotaPoolSheet({
  target,
  onOpenChange,
  onChanged,
}: {
  target: QuotaPoolTarget | null;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void | Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [pool, setPool] = useState<QuotaPoolDetail | null>(null);
  const [error, setError] = useState("");
  const [quotaEdit, setQuotaEdit] = useState<QuotaEditState | null>(null);
  const [savingQuota, setSavingQuota] = useState(false);

  const load = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ provider: target.provider, accountId: String(target.id) });
      const response = await fetch(consoleApiPath(`rosetta/account-quota-pool?${query}`), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data.pool) throw new Error("母号不存在或额度数据不可用");
      setPool(data.pool);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "未知错误";
      setError(message);
      toast.error(`额度池获取失败: ${message}`);
    } finally {
      setLoading(false);
    }
  }, [target]);

  useEffect(() => {
    setPool(null);
    setQuotaEdit(null);
    if (target) void load();
  }, [load, target]);

  const startQuotaEdit = useCallback((subscription: QuotaPoolSubscription) => {
    if (!target) return;
    const seats = Math.max(1, Math.floor(subscription.weight || 1));
    const quota = subscription.usdQuotaPerSeatByProduct[target.provider] || {
      fiveHour: subscription.fiveHour.limit / seats,
      weekly: subscription.weekly.limit / seats,
    };
    setQuotaEdit({
      subscriptionId: subscription.id,
      fiveHour: String(roundUsd(quota.fiveHour)),
      weekly: String(roundUsd(quota.weekly)),
    });
  }, [target]);

  const saveQuota = useCallback(async (subscription: QuotaPoolSubscription) => {
    if (!target || !quotaEdit || quotaEdit.subscriptionId !== subscription.id) return;
    const parsed = parseQuotaEdit(quotaEdit);
    if (!parsed.value) return;

    const nextQuota = {
      ...subscription.usdQuotaPerSeatByProduct,
      [target.provider]: parsed.value,
    };
    const invalidPreservedProduct = Object.entries(nextQuota).find(([, quota]) => (
      !(quota.fiveHour > 0) && !(quota.weekly > 0)
    ));
    if (invalidPreservedProduct) {
      toast.error(`${invalidPreservedProduct[0]} 原额度不完整，请先在订阅详情中补齐`);
      return;
    }

    setSavingQuota(true);
    try {
      await apiRequest(`subscriptions/${subscription.id}`, {
        method: "PATCH",
        body: { usdQuotaPerSeatByProduct: nextQuota },
      });
      toast.success(`已更新 ${subscription.customerEmail || subscription.id} 的单份额度`);
      setQuotaEdit(null);
      await Promise.all([load(), onChanged?.()]);
    } catch (cause) {
      toast.error(`限额更新失败: ${getErrorMessage(cause)}`);
    } finally {
      setSavingQuota(false);
    }
  }, [load, onChanged, quotaEdit, target]);

  const risk = pool ? strongestRisk(pool) : null;

  return (
    <Sheet open={Boolean(target)} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-4xl">
        <SheetHeader className="border-b pr-12">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <SheetTitle>额度池 · {target?.provider === "codex" ? "Codex" : "Anthropic"} #{target?.id}</SheetTitle>
              <SheetDescription className="truncate">{target?.email}</SheetDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
              刷新数据
            </Button>
          </div>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 pb-6">
          {loading && !pool ? <QuotaPoolSkeleton /> : null}

          {error && !pool ? (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>额度池加载失败</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {pool ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{pool.planType || "未知套餐"}</Badge>
                <Badge variant="secondary">ACTIVE 订阅 {pool.activeSubscriptionCount}</Badge>
                <Badge variant="secondary">{pool.totalSeats} 份</Badge>
                <span className="text-xs text-muted-foreground">
                  {pool.refreshedAt ? `${new Date(pool.refreshedAt).toLocaleString()} 刷新` : "额度从未刷新"}
                </span>
              </div>

              <div className="overflow-x-auto rounded-lg border">
                <Table className="min-w-[760px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>窗口</TableHead>
                      <TableHead>母号剩余</TableHead>
                      <TableHead>推算整池</TableHead>
                      <TableHead>已售额度</TableHead>
                      <TableHead>客户待用</TableHead>
                      <TableHead>覆盖率</TableHead>
                      <TableHead>可信度</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <QuotaPoolScopeRow label="5 小时" scope={pool.fiveHour} />
                    <QuotaPoolScopeRow label="每周" scope={pool.weekly} />
                  </TableBody>
                </Table>
              </div>

              {risk ? (
                <Alert variant={pool.alert === "danger" ? "destructive" : "default"}>
                  <TriangleAlertIcon />
                  <AlertTitle>{risk.label}额度覆盖不足</AlertTitle>
                  <AlertDescription>
                    当前物理剩余约 {formatQuotaUsd(risk.scope.inferredRemainingUsd)}，客户待用约 {formatQuotaUsd(risk.scope.customerRemainingUsd)}，缺口约 {formatQuotaUsd(risk.scope.shortfallUsd)}。
                  </AlertDescription>
                </Alert>
              ) : null}

              <section className="flex flex-col gap-2" aria-labelledby="quota-pool-subscriptions">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 id="quota-pool-subscriptions" className="font-medium">关联订阅</h3>
                  <span className="text-xs text-muted-foreground">
                    当前绑定 {pool.subscriptions.length} 条 · 有归因用量 {pool.accountingSubscriptionCount} 条
                  </span>
                </div>
                <div className="overflow-x-auto rounded-lg border">
                  <Table className="min-w-[760px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>客户</TableHead>
                        <TableHead>份额</TableHead>
                        <TableHead>5h 已用 / 上限</TableHead>
                        <TableHead>周已用 / 上限</TableHead>
                        <TableHead>到期</TableHead>
                        <TableHead>归因</TableHead>
                        <TableHead className="text-right">限额</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pool.subscriptions.length ? pool.subscriptions.map((subscription) => (
                        <Fragment key={subscription.id}>
                          <TableRow>
                            <TableCell>
                              <div className="font-medium">{subscription.customerEmail || "—"}</div>
                              <div className="text-xs text-muted-foreground">
                                {subscription.customerName || subscription.order?.outTradeNo || subscription.id}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge variant={subscription.exclusive ? "default" : "secondary"}>
                                {subscription.exclusive ? "独享" : "拼车"} · {subscription.weight} 份
                              </Badge>
                            </TableCell>
                            <TableCell className="font-mono text-xs tabular-nums">
                              {quotaUsage(subscription.fiveHour.used, subscription.fiveHour.limit)}
                            </TableCell>
                            <TableCell className="font-mono text-xs tabular-nums">
                              {quotaUsage(subscription.weekly.used, subscription.weekly.limit)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                              {subscription.expiresAt ? formatDateTime(subscription.expiresAt) : "长期"}
                            </TableCell>
                            <TableCell>
                              <Badge variant={subscription.includedInEstimate ? "outline" : "destructive"}>
                                {subscription.includedInEstimate ? "当前母号" : "其他母号"}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={savingQuota}
                                onClick={() => startQuotaEdit(subscription)}
                              >
                                <PencilIcon data-icon="inline-start" />
                                修改
                              </Button>
                            </TableCell>
                          </TableRow>
                          {quotaEdit?.subscriptionId === subscription.id ? (
                            <TableRow className="hover:bg-transparent">
                              <TableCell colSpan={7} className="bg-muted/30 p-0">
                                <QuotaLimitEditor
                                  edit={quotaEdit}
                                  pool={pool}
                                  subscription={subscription}
                                  provider={target?.provider || pool.provider}
                                  saving={savingQuota}
                                  onChange={setQuotaEdit}
                                  onCancel={() => setQuotaEdit(null)}
                                  onSave={() => void saveQuota(subscription)}
                                />
                              </TableCell>
                            </TableRow>
                          ) : null}
                        </Fragment>
                      )) : (
                        <TableRow>
                          <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                            该母号暂无 ACTIVE 订阅绑定
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </section>

              <details className="rounded-lg border px-3 py-2 text-sm">
                <summary className="cursor-pointer font-medium">计算依据与排除项</summary>
                <div className="mt-3 flex flex-col gap-3 text-muted-foreground">
                  <ScopeEvidence label="5 小时" scope={pool.fiveHour} />
                  <ScopeEvidence label="每周" scope={pool.weekly} />
                  <p>推算整池 = 关联订阅已追踪美元 ÷ 母号已消耗比例。结果是 API 原价等价估算，不是现金余额。</p>
                </div>
              </details>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function QuotaLimitEditor({
  edit,
  pool,
  subscription,
  provider,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  edit: QuotaEditState;
  pool: QuotaPoolDetail;
  subscription: QuotaPoolSubscription;
  provider: "codex" | "anthropic";
  saving: boolean;
  onChange: (next: QuotaEditState) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const parsed = parseQuotaEdit(edit);
  const seats = Math.max(1, Math.floor(subscription.weight || 1));
  const fiveHourTotal = parsed.value ? roundUsd(parsed.value.fiveHour * seats) : 0;
  const weeklyTotal = parsed.value ? roundUsd(parsed.value.weekly * seats) : 0;
  const warnings: string[] = [];

  if (parsed.value) {
    if (fiveHourTotal < subscription.fiveHour.used || weeklyTotal < subscription.weekly.used) {
      warnings.push("新上限低于当前已用量；已用量会保留，对应窗口在重置前将显示 0 可用。");
    }
    const projectedFiveHour = pool.fiveHour.customerRemainingUsd
      - subscription.fiveHour.remaining
      + Math.max(0, fiveHourTotal - subscription.fiveHour.used);
    const projectedWeekly = pool.weekly.customerRemainingUsd
      - subscription.weekly.remaining
      + Math.max(0, weeklyTotal - subscription.weekly.used);
    if (
      (pool.fiveHour.inferredRemainingUsd !== null && projectedFiveHour > pool.fiveHour.inferredRemainingUsd)
      || (pool.weekly.inferredRemainingUsd !== null && projectedWeekly > pool.weekly.inferredRemainingUsd)
    ) {
      warnings.push("保存后客户待用额度将超过当前推算的母号物理剩余，额度池会出现覆盖风险。");
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="font-medium">修改 {provider === "codex" ? "Codex" : "Anthropic"} 单份额度</p>
          <p className="text-sm text-muted-foreground">
            该订阅共 {seats} 份；只修改上限，当前已用量和窗口重置时间不会清零。
          </p>
        </div>
        {parsed.value ? (
          <Badge variant="outline">
            新总额 5h {formatQuotaUsd(fiveHourTotal)} · 周 {formatQuotaUsd(weeklyTotal)}
          </Badge>
        ) : null}
      </div>

      <FieldGroup className="grid gap-3 sm:grid-cols-2">
        <Field data-invalid={Boolean(parsed.error)}>
          <FieldLabel htmlFor={`quota-${subscription.id}-five-hour`}>5 小时 / 单份</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id={`quota-${subscription.id}-five-hour`}
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={edit.fiveHour}
              aria-invalid={Boolean(parsed.error)}
              disabled={saving}
              onChange={(event) => onChange({ ...edit, fiveHour: event.target.value })}
            />
            <InputGroupAddon align="inline-start">$</InputGroupAddon>
          </InputGroup>
          <FieldDescription>当前单份 {formatQuotaUsd(subscription.fiveHour.limit / seats)}</FieldDescription>
        </Field>
        <Field data-invalid={Boolean(parsed.error)}>
          <FieldLabel htmlFor={`quota-${subscription.id}-weekly`}>每周 / 单份</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id={`quota-${subscription.id}-weekly`}
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={edit.weekly}
              aria-invalid={Boolean(parsed.error)}
              disabled={saving}
              onChange={(event) => onChange({ ...edit, weekly: event.target.value })}
            />
            <InputGroupAddon align="inline-start">$</InputGroupAddon>
          </InputGroup>
          <FieldDescription>当前单份 {formatQuotaUsd(subscription.weekly.limit / seats)}</FieldDescription>
        </Field>
      </FieldGroup>

      {parsed.error ? <FieldError>{parsed.error}</FieldError> : null}
      {warnings.length ? (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>保存前请确认</AlertTitle>
          <AlertDescription>{warnings.join(" ")}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={saving}>取消</Button>
        <Button onClick={onSave} disabled={saving || !parsed.value}>
          {saving ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
          保存限额
        </Button>
      </div>
    </div>
  );
}

function QuotaPoolScopeRow({ label, scope }: { label: string; scope: QuotaPoolScope }) {
  return (
    <TableRow>
      <TableCell className="font-medium">{label}</TableCell>
      <TableCell className="tabular-nums">
        <div>{formatQuotaPercent(scope.remainingPercent)}</div>
        <div className="text-xs text-muted-foreground">≈ {formatQuotaUsd(scope.inferredRemainingUsd)}</div>
      </TableCell>
      <TableCell className="font-mono tabular-nums">≈ {formatQuotaUsd(scope.inferredTotalUsd)}</TableCell>
      <TableCell className="font-mono tabular-nums">{formatQuotaUsd(scope.soldLimitUsd)}</TableCell>
      <TableCell className="font-mono tabular-nums">{formatQuotaUsd(scope.customerRemainingUsd)}</TableCell>
      <TableCell className="font-medium tabular-nums">{formatCoverage(scope.coverageRatio)}</TableCell>
      <TableCell><Badge variant="outline">{confidenceLabel(scope.confidence)}</Badge></TableCell>
    </TableRow>
  );
}

function ScopeEvidence({ label, scope }: { label: string; scope: QuotaPoolScope }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="font-medium text-foreground">{label}</p>
      <p>母号剩余 {formatQuotaPercent(scope.remainingPercent)}，已追踪 {formatQuotaUsd(scope.trackedUsedUsd)}，已售 {formatQuotaUsd(scope.soldLimitUsd)}。</p>
      {scope.reasons.map((reason) => <p key={reason}>· {reason}</p>)}
    </div>
  );
}

function QuotaPoolSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-label="正在加载额度池">
      <div className="flex gap-2"><Skeleton className="h-5 w-20" /><Skeleton className="h-5 w-28" /></div>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
