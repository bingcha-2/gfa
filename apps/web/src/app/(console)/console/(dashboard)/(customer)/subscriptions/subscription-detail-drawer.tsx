"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { buildSubscriptionView } from "@/lib/console/subscription-view";
import { RebindRow } from "./rebind-row";
import type { ConsoleSubscription } from "@/lib/console/types";

export function SubscriptionDetailDrawer({
  sub,
  open,
  onOpenChange,
  onChanged,
}: {
  sub: ConsoleSubscription | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onChanged: () => void | Promise<void>;
}) {
  const [usdQuotaPerSeat, setUsdQuotaPerSeat] = useState<Record<string, { fiveHour: string; weekly: string }>>({});
  const [usdQuotaUsageByProduct, setUsdQuotaUsageByProduct] = useState<NonNullable<ConsoleSubscription["usdQuotaUsageByProduct"]>>({});
  const [savingUsd, setSavingUsd] = useState(false);
  const [resettingWindow, setResettingWindow] = useState<string | null>(null);

  useEffect(() => {
    if (!sub) return;
    let products: string[] = [];
    try { products = JSON.parse(sub.productEntitlements || "[]"); } catch { products = []; }
    const seats = Math.max(1, Math.floor(Number(sub.shareSeats ?? sub.weight) || 1));
    setUsdQuotaPerSeat(Object.fromEntries(products
      .filter((product) => product === "codex" || product === "anthropic")
      .map((product) => {
        const total = sub.usdQuotaByProduct?.[product];
        return [product, {
          fiveHour: String((Number(total?.fiveHour) || 0) / seats),
          weekly: String((Number(total?.weekly) || 0) / seats),
        }];
      })));
    setUsdQuotaUsageByProduct(sub.usdQuotaUsageByProduct ?? {});
  }, [sub]);

  if (!sub) return null;
  const view = buildSubscriptionView(sub);
  const shareSeats = Math.max(1, Math.floor(Number(sub.shareSeats ?? view.weight) || 1));
  const supportsUsdQuota = view.rows.some((row) => row.product === "codex" || row.product === "anthropic");

  async function saveUsdLimits() {
    const payload: Record<string, { fiveHour: number; weekly: number }> = {};
    for (const [product, values] of Object.entries(usdQuotaPerSeat)) {
      const fiveHour = Number(values.fiveHour);
      const weekly = Number(values.weekly);
      if (!Number.isFinite(fiveHour) || fiveHour < 0 || !Number.isFinite(weekly) || weekly < 0) {
        toast.error(`${product} 美元额度必须是大于等于 0 的数字`);
        return;
      }
      if (fiveHour === 0 && weekly === 0) {
        toast.error(`${product} 的 5 小时和每周额度不能同时为 0`);
        return;
      }
      payload[product] = { fiveHour, weekly };
    }
    try {
      setSavingUsd(true);
      await apiRequest(`subscriptions/${sub!.id}`, {
        method: "PATCH",
        body: { usdQuotaPerSeatByProduct: payload },
      });
      toast.success("美元额度已更新，当前周期已用金额保持不变");
      await onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSavingUsd(false);
    }
  }

  async function resetUsdUsage(product: string, scope: "fiveHour" | "weekly") {
    const key = `${product}.${scope}`;
    try {
      setResettingWindow(key);
      const result = await apiRequest<{
        usageByProduct: NonNullable<ConsoleSubscription["usdQuotaUsageByProduct"]>;
      }>(`subscriptions/${sub!.id}/usd-quota/reset`, {
        method: "POST",
        body: { product, scope },
      });
      setUsdQuotaUsageByProduct(result.usageByProduct ?? {});
      toast.success(`${product === "codex" ? "Codex" : "Anthropic"} ${scope === "fiveHour" ? "5 小时" : "每周"}已用额度已清零`);
      await onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
      throw err;
    } finally {
      setResettingWindow(null);
    }
  }

  async function revoke() {
    try {
      await apiRequest(`subscriptions/${sub!.id}/revoke`, { method: "POST" });
      toast.success("已撤销订阅");
      onOpenChange(false);
      await onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction="right">
      <DrawerContent className="ml-auto h-full w-full max-w-md">
        <DrawerHeader>
          <DrawerTitle>订阅详情</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-4 space-y-4 overflow-y-auto">
          <div className="text-sm text-muted-foreground">
            <a
              className="text-blue-600 hover:underline"
              href={`/console/customers/${sub.customerId}`}
            >
              客户 {sub.customer?.email ?? sub.customerId} ↗
            </a>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={
                view.line === "bind"
                  ? "border-blue-300 text-blue-600"
                  : "text-muted-foreground"
              }
            >
              {view.line === "bind" ? "绑定线" : "号池线"}
            </Badge>
            <Badge variant="secondary">{sub.status}</Badge>
            <span className="text-xs text-muted-foreground">
              拼车 {shareSeats} 份 · 设备 {view.deviceLimit} 台
            </span>
          </div>
          {view.line === "bind" ? (
            <>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground mb-1">产品与绑定</div>
                {view.rows.map((row) => (
                  <RebindRow key={row.product} subId={sub.id} row={row} onDone={onChanged} />
                ))}
              </div>
              {supportsUsdQuota && <div className="rounded-md border p-3 space-y-3">
                <div>
                  <div className="text-sm font-medium">拼车美元额度</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    按产品修改单份额度；系统会乘以该订阅的 {shareSeats} 份得到总额度，并保留当前窗口已用金额。
                    单项填 0 表示不启用，单个产品不能两项都为 0。
                  </div>
                </div>
                {Object.entries(usdQuotaPerSeat).map(([product, values]) => (
                  <div key={product} className="rounded-md border p-2.5 space-y-2">
                    <div className="text-sm font-medium">{product === "codex" ? "Codex" : "Anthropic"} · 单份</div>
                    {([['fiveHour', '5 小时额度'], ['weekly', '每周额度']] as const).map(([key, label]) => (
                      <label key={key} className="grid grid-cols-[1fr_9rem] items-center gap-3 text-sm">
                        <span>{label}</span>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                          <Input
                            className="pl-7" type="number" min="0" step="0.01" value={values[key]}
                            onChange={(e) => setUsdQuotaPerSeat((current) => ({
                              ...current,
                              [product]: { ...current[product], [key]: e.target.value },
                            }))}
                          />
                        </div>
                      </label>
                    ))}
                    <div className="border-t pt-2.5 space-y-2.5">
                      <div className="text-xs font-medium text-muted-foreground">当前窗口用量（{shareSeats} 份总额）</div>
                      {([['fiveHour', '5 小时'], ['weekly', '每周']] as const).map(([scope, label]) => {
                        const configuredLimit = Number(sub.usdQuotaByProduct?.[product]?.[scope]) || 0;
                        if (configuredLimit <= 0) return null;
                        const usage = usdQuotaUsageByProduct[product]?.[scope] ?? null;
                        return (
                          <QuotaUsageRow
                            key={scope}
                            label={label}
                            usage={usage}
                            fallbackLimit={configuredLimit}
                            resetting={resettingWindow === `${product}.${scope}`}
                            onReset={() => resetUsdUsage(product, scope)}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
                <Button className="w-full" disabled={savingUsd} onClick={() => void saveUsdLimits()}>
                  {savingUsd ? "保存中…" : "保存美元额度"}
                </Button>
              </div>}
            </>
          ) : (
            <div className="rounded-md border p-3 text-sm">
              号池线 · 用量档 {view.usageTier ?? "—"} · 运行时动态调度,不绑定具体号。
            </div>
          )}
          {sub.status === "ACTIVE" && (
            <div className="flex justify-end pt-2 border-t">
              <Button
                variant="outline"
                className="text-destructive border-destructive/40"
                onClick={() => void revoke()}
              >
                撤销订阅
              </Button>
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function QuotaUsageRow({
  label,
  usage,
  fallbackLimit,
  resetting,
  onReset,
}: {
  label: string;
  usage: { used: number; limit: number; resetAt: string } | null;
  fallbackLimit: number;
  resetting: boolean;
  onReset: () => Promise<void>;
}) {
  const used = Math.max(0, Number(usage?.used) || 0);
  const limit = Math.max(0, Number(usage?.limit) || fallbackLimit);
  const percent = limit > 0 ? (used / limit) * 100 : 0;
  const resetText = formatResetAt(usage?.resetAt);

  return (
    <div className="space-y-1.5" data-testid={`quota-usage-${label}`}>
      <div className="flex items-start justify-between gap-3 text-xs">
        <div className="min-w-0">
          <div className="font-medium text-foreground">{label}</div>
          {usage ? (
            <div className="mt-0.5 text-muted-foreground tabular-nums">
              已用 {formatUsd(used)} / {formatUsd(limit)}
              {resetText ? ` · ${resetText}` : " · 等待上游重置时间"}
            </div>
          ) : (
            <div className="mt-0.5 text-muted-foreground">运行时窗口未启用</div>
          )}
        </div>
        {usage && (
          <ResetQuotaButton
            label={label}
            used={used}
            disabled={used <= 0 || resetting}
            loading={resetting}
            onConfirm={onReset}
          />
        )}
      </div>
      {usage && (
        <div className="flex items-center gap-2">
          <Progress value={Math.min(100, percent)} className="flex-1" aria-label={`${label}已用 ${percent.toFixed(1)}%`} />
          <span className={`w-12 text-right text-xs tabular-nums ${percent >= 100 ? "text-destructive" : "text-muted-foreground"}`}>
            {percent.toFixed(1)}%
          </span>
        </div>
      )}
    </div>
  );
}

function ResetQuotaButton({
  label,
  used,
  disabled,
  loading,
  onConfirm,
}: {
  label: string;
  used: number;
  disabled: boolean;
  loading: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  async function confirm() {
    try {
      await onConfirm();
      setOpen(false);
    } catch {
      // The caller already surfaced the API error. Keep the confirmation open
      // so the operator can retry or cancel without an unhandled rejection.
    }
  }
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={disabled} />}>
        {loading ? "清零中…" : "清零已用"}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>清零{label}已用额度？</AlertDialogTitle>
          <AlertDialogDescription>
            当前已用 {formatUsd(used)} 将立即变为 $0。另一个额度窗口和上游重置时间不受影响，此操作会记录审计日志。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={() => void confirm()} disabled={loading}>
            {loading ? "清零中…" : "确认清零"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatResetAt(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)} 重置`;
}
