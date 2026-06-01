"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { RefreshCw, Search, ShieldOff, SlidersHorizontal } from "lucide-react";

import type { StatusData, EnrichedAccount } from "./types";
import {
  PAGE_SIZE,
  COLUMN_CONFIG,
  DEFAULT_VISIBLE_COLS,
  MODEL_QUOTA_OPTIONS,
  DEFAULT_VISIBLE_MODEL_QUOTAS,
  migrateVisibleColumns,
} from "./constants";
import { CreditQuotaDashboard } from "./credit-quota-dashboard";
import { ServerOverviewPanel } from "./server-overview-panel";
import { AccountsTable } from "./accounts-table";
import { ThrottleConfigPanel } from "./throttle-config-panel";

// ── Component ──

export default function RosettaLoadPage() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("rosetta-load-visible-cols");
        if (saved) {
          const arr = JSON.parse(saved) as string[];
          if (Array.isArray(arr) && arr.length > 0) return migrateVisibleColumns(arr);
        }
      } catch { /* ignore */ }
    }
    return new Set(DEFAULT_VISIBLE_COLS);
  });
  const [visibleModelQuotaIds, setVisibleModelQuotaIds] = useState<Set<string>>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("rosetta-load-visible-model-quotas");
        if (saved) {
          const arr = JSON.parse(saved) as string[];
          const allowed = new Set(MODEL_QUOTA_OPTIONS.map((model) => model.id));
          const filtered = arr.filter((id) => allowed.has(id));
          if (filtered.length > 0) return new Set(filtered);
        }
      } catch { /* ignore */ }
    }
    return new Set(DEFAULT_VISIBLE_MODEL_QUOTAS);
  });
  useEffect(() => {
    try {
      localStorage.setItem("rosetta-load-visible-cols", JSON.stringify([...visibleCols]));
    } catch { /* ignore */ }
  }, [visibleCols]);
  useEffect(() => {
    try {
      localStorage.setItem("rosetta-load-visible-model-quotas", JSON.stringify([...visibleModelQuotaIds]));
    } catch { /* ignore */ }
  }, [visibleModelQuotaIds]);

  const [refreshingQuota, setRefreshingQuota] = useState(false);
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Data fetching ──

  const fetchStatus = useCallback(async (silent = false) => {
    if (!silent) setRefreshingStatus(true);
    try {
      const res = await fetch("/api/remote-token/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: StatusData = await res.json();
      setStatus(data);
    } catch (err) {
      if (!silent) toast.error(`获取状态失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      if (!silent) setRefreshingStatus(false);
    }
  }, []);

  useEffect(() => {
    async function init() {
      setLoading(true);
      await fetchStatus(true);
      setLoading(false);
    }
    init();
    intervalRef.current = setInterval(() => fetchStatus(true), 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchStatus]);

  // ── Actions ──

  async function handleRefreshQuota() {
    setRefreshingQuota(true);
    try {
      const res = await fetch("/api/rosetta/refresh-quota", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      toast.success(
        `额度刷新完成: ${data.refreshed || 0} 成功, ${data.errors || 0} 失败 (共 ${data.total || 0})`
      );
      await fetchStatus(true);
    } catch (err) {
      toast.error(`额度刷新失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setRefreshingQuota(false);
    }
  }

  async function handleUnblockLocation() {
    try {
      const res = await fetch("/api/rosetta/unblock-location", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        toast.success(`已解封 ${data.unblocked || 0} 个账号`);
        await fetchStatus(true);
      } else {
        toast.error("解封失败: " + (data.error || "未知错误"));
      }
    } catch (err) {
      toast.error(`请求失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  async function handleToggleAccount(accountId: string, currentlyEnabled: boolean) {
    setTogglingIds((prev) => new Set(prev).add(accountId));
    const action = currentlyEnabled ? "禁用" : "解封";
    try {
      const res = await fetch("/api/rosetta/toggle-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: Number(accountId), enabled: !currentlyEnabled }),
      });
      const data = await res.json();
      if (data.ok) {
        toast.success(`账号 #${accountId} 已${action}`);
        await fetchStatus(true);
      } else {
        toast.error(`${action}失败: ${data.error || "未知错误"}`);
      }
    } catch (err) {
      toast.error(`${action}请求失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setTogglingIds((prev) => {
        const s = new Set(prev);
        s.delete(accountId);
        return s;
      });
    }
  }

  // ── Derived data ──

  const scheduler = status?.scheduler || {};
  const leaseCounts = scheduler.activeLeaseCounts || {};
  const accountStatsMap = scheduler.accountStats || {};
  const quotaAccounts = status?.quota?.accounts || [];
  const daily = status?.daily || {};

  const allAccounts: EnrichedAccount[] = useMemo(() => {
    const now = Date.now();
    const gateMap = new Map<number, import("./types").ModelGate[]>();
    if (scheduler.modelGates) {
      for (const g of scheduler.modelGates) {
        if (!gateMap.has(g.accountId)) gateMap.set(g.accountId, []);
        gateMap.get(g.accountId)!.push(g);
      }
    }

    return quotaAccounts.map((account) => {
      const id = String(account.id ?? "");
      const s = accountStatsMap[id] || {};
      const activeLeases = Number(leaseCounts[id] ?? account.activeLeases ?? 0);
      const reqStats = account.requestStats || { total: 0, successes: 0, failures: 0 };
      const total = Number(reqStats.total ?? s.totalLeases ?? 0);
      const successes = Number(reqStats.successes ?? s.successCount ?? 0);
      const failures = Number(reqStats.failures ?? s.errorCount ?? 0);
      const successRate =
        account.successRate != null
          ? Number(account.successRate)
          : total > 0
            ? Math.round((successes / total) * 100)
            : null;
      const blockedUntil = Number(account.blockedUntil ?? s.blockedUntil ?? 0);
      const cooldownMs = blockedUntil > now ? blockedUntil - now : 0;
      const allBlockedModels = [
        ...(account.blockedModels || []),
        ...(gateMap.get(Number(account.id)) || []),
      ].filter((m) => m.blockedUntil > now);
      const locationFailures = Number(s.locationFailures || 0);
      const totalTokensUsed = Number(s.totalTokensUsed || 0);
      const totalInputTokens = Number(s.totalInputTokens || 0);
      const totalOutputTokens = Number(s.totalOutputTokens || 0);

      return {
        ...account,
        _id: id,
        _activeLeases: activeLeases,
        _total: total,
        _successes: successes,
        _failures: failures,
        _successRate: successRate,
        _cooldownMs: cooldownMs,
        _blockedModels: allBlockedModels,
        _locationFailures: locationFailures,
        _totalTokensUsed: totalTokensUsed,
        _totalInputTokens: totalInputTokens,
        _totalOutputTokens: totalOutputTokens,
        _lastStatus: s.lastStatus || account.lastStatus || "",
      };
    });
  }, [quotaAccounts, accountStatsMap, leaseCounts, scheduler.modelGates]);

  const summaryReasons = useMemo(() => {
    const reasons: Record<string, number> = {};
    let okCount = 0;
    for (const a of allAccounts) {
      if (a.quotaStatus === "exhausted") {
        const r = a.quotaStatusReason || "unknown";
        reasons[r] = (reasons[r] || 0) + 1;
      } else {
        okCount++;
      }
    }
    return { okCount, reasons };
  }, [allAccounts]);

  const filteredAccounts = useMemo(() => {
    if (!search.trim()) return allAccounts;
    const q = search.trim().toLowerCase();
    return allAccounts.filter((a) => {
      const blockedModelStr = (a._blockedModels || [])
        .map((m) => `${m.modelKey} ${m.reason}`)
        .join(" ");
      const hay = [
        a.email,
        a.planType,
        a.quotaStatus,
        a.quotaStatusReason,
        String(a.id),
        blockedModelStr,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [allAccounts, search]);

  const totalPages = Math.max(1, Math.ceil(filteredAccounts.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageAccounts = filteredAccounts.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const modelPressure = useMemo(() => {
    const now = Date.now();
    const gates = (scheduler.modelGates || []).filter((g) => g.blockedUntil > now);
    const byModel: Record<string, number> = {};
    gates.forEach((g) => {
      byModel[g.modelKey] = (byModel[g.modelKey] || 0) + 1;
    });
    const totalEnabled = quotaAccounts.filter((a) => a.enabled !== false && a.projectId).length;
    return Object.entries(byModel)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([model, count]) => ({
        model: model.replace(/^(tab_|models\/)/, "").replace(/_preview$/, ""),
        count,
        total: totalEnabled,
        pct: totalEnabled > 0 ? Math.round((count / totalEnabled) * 100) : 0,
      }));
  }, [scheduler.modelGates, quotaAccounts]);

  const overviewStats = useMemo(() => {
    const activeLeases = Object.values(leaseCounts).reduce((s, v) => s + Number(v || 0), 0);
    const clients = Number(status?.affinityClients || 0);
    let totalSuccess = 0;
    let totalErr = 0;
    let totalAllTokens = 0;
    for (const s of Object.values(accountStatsMap)) {
      totalSuccess += Number(s.successCount || 0);
      totalErr += Number(s.errorCount || 0);
      totalAllTokens += Number(s.totalTokensUsed || 0);
    }
    const totalReqs = totalSuccess + totalErr;
    const successRate = totalReqs > 0 ? Math.round((totalSuccess / totalReqs) * 100) : 0;
    const dailyRate =
      (daily.leases || 0) > 0
        ? Math.round(((daily.successes || 0) / (daily.leases || 1)) * 100)
        : 0;
    return { activeLeases, clients, successRate, totalAllTokens, dailyRate };
  }, [leaseCounts, status?.affinityClients, accountStatsMap, daily]);

  const enterpriseProbe = status?.enterpriseProbe || {};
  const enterpriseGroups = Object.entries(enterpriseProbe);

  // ── Select / column helpers ──

  function toggleSelectAll(checked: boolean) {
    if (checked) {
      setSelectedIds(new Set(pageAccounts.map((a) => String(a.id))));
    } else {
      setSelectedIds(new Set());
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  }

  function toggleCol(key: string) {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleModelQuota(id: string) {
    setVisibleModelQuotaIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    setPage(1);
  }, [search]);

  const visibleModelQuotaOptions = MODEL_QUOTA_OPTIONS.filter((model) =>
    visibleModelQuotaIds.has(model.id),
  );

  // ── Render ──

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-20 justify-center text-muted-foreground">
        <Spinner size={18} />
        <span className="text-sm">加载中...</span>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-semibold">Antigravity 负载看板</h1>
          <p className="text-sm text-muted-foreground">
            来自 Remote Token Server 调度器的 lease 与账号统计。
          </p>
        </div>

        {/* ── 1. Server Overview Panel ── */}
        {status?.running && (
          <ServerOverviewPanel
            overviewStats={overviewStats}
            daily={daily}
            modelPressure={modelPressure}
            enterpriseGroups={enterpriseGroups}
          />
        )}

        {/* ── 1b. Credit & Quota Dashboard ── */}
        {allAccounts.length > 0 && (
          <CreditQuotaDashboard accounts={allAccounts} />
        )}

        {/* ── 2. Action Bar ── */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Left: search + count */}
          <div className="relative flex-1 min-w-[200px] max-w-[320px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              placeholder="搜索账号 / 状态 / 原因…"
              value={search}
              onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
              className="pl-8 h-8 text-sm"
            />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {search.trim()
              ? `${filteredAccounts.length} / ${allAccounts.length}`
              : `${allAccounts.length} 条`}
          </span>

          {/* Middle: column settings */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="sm">
                  <SlidersHorizontal data-icon className="size-3.5" />
                  列设置
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>显示列</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {COLUMN_CONFIG.map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col.key}
                    checked={visibleCols.has(col.key)}
                    onCheckedChange={() => toggleCol(col.key)}
                  >
                    {col.label}
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>模型额度</DropdownMenuLabel>
                {MODEL_QUOTA_OPTIONS.map((model) => (
                  <DropdownMenuCheckboxItem
                    key={model.id}
                    checked={visibleModelQuotaIds.has(model.id)}
                    onCheckedChange={() => toggleModelQuota(model.id)}
                    disabled={!visibleCols.has("modelQuota")}
                  >
                    {model.displayName}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Right: action buttons */}
          <div className="flex items-center gap-1.5 ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefreshQuota}
              disabled={refreshingQuota}
            >
              {refreshingQuota ? (
                <Spinner size={14} className="mr-1" />
              ) : (
                <RefreshCw data-icon className="size-3.5" />
              )}
              刷新额度
            </Button>
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button variant="outline" size="sm">
                    <ShieldOff data-icon className="size-3.5" />
                    解封地区
                  </Button>
                }
              />
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认解封地区</AlertDialogTitle>
                  <AlertDialogDescription>
                    确定解封所有 location_unsupported 封禁的账号？
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={handleUnblockLocation}>确认解封</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <Separator orientation="vertical" className="mx-1 h-6" />

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="px-2"
                    onClick={() => fetchStatus()}
                    disabled={refreshingStatus}
                  />
                }
              >
                {refreshingStatus ? (
                  <Spinner size={14} />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
              </TooltipTrigger>
              <TooltipContent>刷新状态</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* ── 3-4. Summary + Accounts Table ── */}
        <AccountsTable
          filteredAccounts={filteredAccounts}
          pageAccounts={pageAccounts}
          page={page}
          totalPages={totalPages}
          safePage={safePage}
          selectedIds={selectedIds}
          visibleCols={visibleCols}
          visibleModelQuotaOptions={visibleModelQuotaOptions}
          togglingIds={togglingIds}
          summaryReasons={summaryReasons}
          search={search}
          onPageChange={setPage}
          onToggleSelectAll={toggleSelectAll}
          onToggleSelect={toggleSelect}
          onToggleAccount={handleToggleAccount}
        />

        {/* ── 5. Throttle Config ── */}
        <Separator />
        <ThrottleConfigPanel />
      </div>
    </TooltipProvider>
  );
}
