"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
  CopyIcon,
  SearchIcon,
  XIcon,
  PauseIcon,
  PlayIcon,
  Trash2Icon,
  ArrowUpDownIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  KeyIcon,
  AlertTriangleIcon,
  Loader2Icon,
  UnplugIcon,
  BarChart3Icon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { CardUsageDialog } from "./card-usage-dialog";
import { CardLimitsDialog } from "./card-limits-dialog";
import { BindAccountControl, type BindableAccount } from "@/components/BindAccountControl";
import { toBindableAccounts } from "@/lib/bindable-accounts";

type AccessKey = {
  id: string;
  name: string;
  fullKey: string;
  key: string;
  status: string;
  totalRequests: number;
  totalTokensUsed: number;
  recentWindowTokens: number;
  tokenWindowLimit: number;
  windowMs?: number;
  bindings?: Record<string, number>;
  weight?: number;
  durationMs?: number;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  sessionClientId: string;
  sessionExpiresAt: string;
  anomalyCount?: number;
  bucketLimits?: Record<string, number>;
};

const PAGE_SIZE = 20;

type SortField =
  | "totalTokensUsed"
  | "recentWindowTokens"
  | "totalRequests"
  | "anomalyCount"
  | "createdAt"
  | null;

function formatDuration(ms: number | undefined | null): string {
  if (!ms || ms <= 0) return "永久";
  const hours = ms / 3600000;
  if (hours < 24) return `${Math.round(hours)}小时`;
  return `${Math.round(hours / 24)}天`;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function RosettaKeysPage() {
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [totalAll, setTotalAll] = useState(0);
  const [totalActive, setTotalActive] = useState(0);

  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  // Create form state
  const [createName, setCreateName] = useState("");
  const [createDurationValue, setCreateDurationValue] = useState("1");
  const [createDurationUnit, setCreateDurationUnit] = useState("d");
  const [createLimit, setCreateLimit] = useState("");
  const [createTokenLimit, setCreateTokenLimit] = useState("");
  const [createWindowValue, setCreateWindowValue] = useState("5");
  const [createWindowUnit, setCreateWindowUnit] = useState("h");
  const [createCount, setCreateCount] = useState("1");
  // Products the new card is sold for. None selected = pool-mode card (no
  // binding); selecting one/both auto-binds an open-seat account per product.
  const [createCodex, setCreateCodex] = useState(false);
  const [createAnti, setCreateAnti] = useState(false);
  // 会员等级(planType):每个开通的产品必选一个等级,只绑定该等级且可用的账号。
  const [createCodexLevel, setCreateCodexLevel] = useState("");
  const [createAntiLevel, setCreateAntiLevel] = useState("");
  // 可选:手动指定要绑定的账号("" = 自动分配)。选了就整批绑到该号。
  const [createCodexAccountId, setCreateCodexAccountId] = useState("");
  const [createAntiAccountId, setCreateAntiAccountId] = useState("");
  // 各号池里存在的等级选项(去重),用于上面的下拉。
  const [codexLevels, setCodexLevels] = useState<string[]>([]);
  const [antiLevels, setAntiLevels] = useState<string[]>([]);
  // 份额(weight):1 拼车(4人共享一个号)… 4 独享(一张卡占满一个号)。
  const [createWeight, setCreateWeight] = useState("1");
  const [creating, setCreating] = useState(false);

  // Key reveal dialog
  const [revealKeys, setRevealKeys] = useState<string[]>([]);
  const [revealOpen, setRevealOpen] = useState(false);

  // Delete dialog
  const [deleteTarget, setDeleteTarget] = useState<AccessKey | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Token usage detail dialog
  const [usageTarget, setUsageTarget] = useState<AccessKey | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);

  // Card limits dialog
  const [limitsTarget, setLimitsTarget] = useState<AccessKey | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);

  // Cleanup states
  const [cleaningExpired, setCleaningExpired] = useState(false);
  const [cleanExpiredOpen, setCleanExpiredOpen] = useState(false);
  const [cleaningUnbound, setCleaningUnbound] = useState(false);
  const [cleanUnboundOpen, setCleanUnboundOpen] = useState(false);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchKeys = useCallback(
    async (searchTerm?: string) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        const term = (searchTerm ?? search).trim();
        if (term) params.set("search", term);
        const res = await fetch(
          `/api/rosetta/access-keys${params.toString() ? `?${params}` : ""}`
        );
        const data = await res.json();
        if (data.ok) {
          const allKeys: AccessKey[] = data.keys || [];
          setKeys(allKeys);
          setTotalAll(data.totalAll ?? allKeys.length);
          setTotalActive(
            data.totalActive ??
              allKeys.filter((k) => k.status === "active").length
          );
        }
      } catch {
        toast.error("加载卡密失败");
      } finally {
        setLoading(false);
      }
    },
    [search]
  );

  useEffect(() => {
    fetchKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bindable accounts across both pools (for the static card→account binding UI).
  const [bindableAccounts, setBindableAccounts] = useState<BindableAccount[]>([]);

  const fetchBindableAccounts = useCallback(async () => {
    try {
      const [codexRes, antiRes] = await Promise.all([
        fetch("/api/rosetta/codex-accounts"),
        fetch("/api/rosetta/accounts"),
      ]);
      const codex = await codexRes.json();
      const anti = await antiRes.json();
      setBindableAccounts(toBindableAccounts(codex.accounts, anti.accounts));
      // Distinct, non-empty membership levels present in each pool (for the
      // create form's per-product level picker).
      const levelsOf = (list: Array<{ planType?: string }> | undefined) =>
        [...new Set((list || []).map((a) => String(a.planType || "").trim()).filter(Boolean))].sort();
      setCodexLevels(levelsOf(codex.accounts));
      setAntiLevels(levelsOf(anti.accounts));
    } catch {
      // Non-fatal: the binding picker just shows no accounts.
    }
  }, []);

  useEffect(() => {
    fetchBindableAccounts();
  }, [fetchBindableAccounts]);

  // Level is required per checked product: default to the first available level
  // when a product is enabled (or its current pick is no longer valid), and
  // clear it when the product is unchecked.
  useEffect(() => {
    if (!createCodex) return setCreateCodexLevel("");
    if (codexLevels.length && !codexLevels.includes(createCodexLevel)) {
      setCreateCodexLevel(codexLevels[0]);
    }
  }, [createCodex, codexLevels, createCodexLevel]);
  useEffect(() => {
    if (!createAnti) return setCreateAntiLevel("");
    if (antiLevels.length && !antiLevels.includes(createAntiLevel)) {
      setCreateAntiLevel(antiLevels[0]);
    }
  }, [createAnti, antiLevels, createAntiLevel]);

  // 产品关闭或等级变化时,清掉手动选的账号(避免把别的等级的旧选择带出去)。
  useEffect(() => {
    setCreateCodexAccountId("");
  }, [createCodex, createCodexLevel]);
  useEffect(() => {
    setCreateAntiAccountId("");
  }, [createAnti, createAntiLevel]);

  const handleBind = async (cardId: string, provider: string, accountId: number) => {
    try {
      const res = await fetch("/api/rosetta/access-key-bind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cardId, provider, accountId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "绑定失败");
      toast.success("已绑定账号");
      await Promise.all([fetchKeys(), fetchBindableAccounts()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "绑定失败");
    }
  };

  const handleUnbind = async (cardId: string, provider: string) => {
    try {
      const res = await fetch("/api/rosetta/access-key-unbind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cardId, provider }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "解绑失败");
      toast.success("已解绑");
      await Promise.all([fetchKeys(), fetchBindableAccounts()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "解绑失败");
    }
  };

  const handleSearchInput = (value: string) => {
    setSearch(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setPage(1);
      fetchKeys(value);
    }, 300);
  };

  const handleSearchClear = () => {
    setSearch("");
    setPage(1);
    fetchKeys("");
  };

  const handleSearchSubmit = () => {
    setPage(1);
    fetchKeys();
  };

  // Sorting & pagination
  const sortedKeys = useMemo(() => {
    if (!sortField) return keys;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...keys].sort((a, b) => {
      if (sortField === "createdAt") {
        const av = new Date(a.createdAt || 0).getTime();
        const bv = new Date(b.createdAt || 0).getTime();
        return (av - bv) * dir;
      }
      const av = Number((a as Record<string, unknown>)[sortField] || 0);
      const bv = Number((b as Record<string, unknown>)[sortField] || 0);
      return (av - bv) * dir;
    });
  }, [keys, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedKeys.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageKeys = sortedKeys.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
    setPage(1);
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field)
      return <ArrowUpDownIcon data-icon className="size-3 opacity-40" />;
    return sortDir === "desc" ? (
      <ArrowDownIcon data-icon className="size-3" />
    ) : (
      <ArrowUpIcon data-icon className="size-3" />
    );
  };

  // Create access key
  const handleCreate = async () => {
    setCreating(true);
    try {
      const durationValue = Math.max(
        1,
        Math.floor(Number(createDurationValue) || 1)
      );
      const durationMs =
        durationValue *
        (createDurationUnit === "d" ? 86400000 : 3600000);
      const windowValue = Math.max(1, Math.floor(Number(createWindowValue) || 1));
      const windowMs =
        windowValue * (createWindowUnit === "d" ? 86400000 : 3600000);
      const count = Math.max(1, Math.min(200, Number(createCount) || 1));

      const payload: Record<string, unknown> = {
        name: createName.trim() || undefined,
        durationMs,
        windowMs,
        count,
      };
      if (createLimit.trim()) {
        payload.windowLimit = Number(createLimit);
      }
      if (createTokenLimit.trim()) {
        payload.tokenWindowLimit = Number(createTokenLimit);
      }
      const products = [
        ...(createCodex ? ["codex"] : []),
        ...(createAnti ? ["antigravity"] : []),
      ];
      if (products.length) {
        // Level is required for every selected product.
        if (createCodex && !createCodexLevel) throw new Error("请选择 Codex 会员等级");
        if (createAnti && !createAntiLevel) throw new Error("请选择 Antigravity 会员等级");
        payload.products = products;
        payload.levels = {
          ...(createCodex ? { codex: createCodexLevel } : {}),
          ...(createAnti ? { antigravity: createAntiLevel } : {}),
        };
        // 可选:手动指定账号("" = 自动分配,不传该 product)。
        const accountIds: Record<string, number> = {
          ...(createCodex && createCodexAccountId ? { codex: Number(createCodexAccountId) } : {}),
          ...(createAnti && createAntiAccountId ? { antigravity: Number(createAntiAccountId) } : {}),
        };
        if (Object.keys(accountIds).length) payload.accountIds = accountIds;
        payload.weight = Math.max(1, Math.min(4, Number(createWeight) || 1));
      }

      const res = await fetch("/api/rosetta/access-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "创建失败");

      const created: AccessKey[] = Array.isArray(data.keys)
        ? data.keys
        : data.key
          ? [data.key]
          : [];
      const fullKeys = created
        .map((k) => k.fullKey || "")
        .filter(Boolean);

      toast.success(`已生成 ${created.length || 1} 张卡密`);
      setCreateName("");

      if (fullKeys.length > 0) {
        setRevealKeys(fullKeys);
        setRevealOpen(true);
        await navigator.clipboard
          ?.writeText(fullKeys.join("\n"))
          .catch(() => {});
      }
      fetchKeys();
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "创建失败"
      );
    } finally {
      setCreating(false);
    }
  };

  // Toggle status
  const handleToggle = async (key: AccessKey) => {
    const newStatus = key.status === "active" ? "disabled" : "active";
    try {
      const res = await fetch("/api/rosetta/access-key-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: key.id, status: newStatus }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "操作失败");
      toast.success(newStatus === "active" ? "卡密已启用" : "卡密已禁用");
      fetchKeys();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    }
  };

  // Copy key
  const handleCopy = async (value: string) => {
    if (!value) {
      toast.error("卡密为空");
      return;
    }
    await navigator.clipboard?.writeText(value).catch(() => {});
    toast.success("卡密已复制");
  };

  // Delete
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/rosetta/access-key-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteTarget.id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "删除失败");
      toast.success("卡密已删除");
      setDeleteOpen(false);
      setDeleteTarget(null);
      fetchKeys();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  // Cleanup expired keys
  const handleCleanupExpired = async () => {
    setCleaningExpired(true);
    try {
      const res = await fetch("/api/rosetta/cleanup-expired-keys", { method: "POST" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "清理失败");
      toast.success(data.deleted > 0 ? `已清理 ${data.deleted} 条过期卡密` : "没有需要清理的过期卡密");
      setCleanExpiredOpen(false);
      fetchKeys();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "清理失败");
    } finally {
      setCleaningExpired(false);
    }
  };

  // Cleanup unbound keys
  const handleCleanupUnbound = async () => {
    setCleaningUnbound(true);
    try {
      const res = await fetch("/api/rosetta/cleanup-unbound-keys", { method: "POST" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "清理失败");
      toast.success(data.deleted > 0 ? `已清理 ${data.deleted} 条未绑定设备的卡密` : "没有需要清理的未绑定卡密");
      setCleanUnboundOpen(false);
      fetchKeys();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "清理失败");
    } finally {
      setCleaningUnbound(false);
    }
  };

  const statusVariant = (status: string) => {
    switch (status) {
      case "active":
        return "default" as const;
      case "disabled":
        return "secondary" as const;
      case "revoked":
        return "destructive" as const;
      default:
        return "secondary" as const;
    }
  };

  // 整批卡需要的份额 = 份额 × 张数;用于手动选号下拉的"份额不足"判断。
  const numWeight = Math.max(1, Math.min(4, Number(createWeight) || 1));
  const numCount = Math.max(1, Math.min(200, Number(createCount) || 1));
  const accountPickerOptions = (provider: string, level: string) =>
    bindableAccounts.filter((a) => a.provider === provider && a.planType === level);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">卡密管理</h1>
        <p className="text-sm text-muted-foreground">
          生成卡密、查看有效期与 token 用量。有效期从第一次使用开始计算。
        </p>
      </div>

      {/* Create Form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">生成卡密</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <Field className="min-w-[140px] flex-1">
              <FieldLabel>备注/用户名</FieldLabel>
              <Input
                placeholder="可选"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
              />
            </Field>
            <Field className="min-w-[180px]">
              <FieldLabel>开通产品（不选=池子模式）</FieldLabel>
              <div className="flex items-center gap-3 h-9">
                <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createCodex}
                    onChange={(e) => setCreateCodex(e.target.checked)}
                  />
                  Codex
                </label>
                <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createAnti}
                    onChange={(e) => setCreateAnti(e.target.checked)}
                  />
                  Antigravity
                </label>
              </div>
            </Field>
            {createCodex && (
              <Field className="min-w-[140px]">
                <FieldLabel>Codex 会员等级</FieldLabel>
                <Select value={createCodexLevel} onValueChange={setCreateCodexLevel}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择等级" />
                  </SelectTrigger>
                  <SelectContent>
                    {codexLevels.length ? (
                      codexLevels.map((lv) => (
                        <SelectItem key={lv} value={lv}>
                          {lv}
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value="__none" disabled>
                        无可用等级
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </Field>
            )}
            {createCodex && (
              <Field className="min-w-[200px]">
                <FieldLabel>Codex 账号(可选,默认自动)</FieldLabel>
                <Select
                  value={createCodexAccountId || "__auto"}
                  onValueChange={(v) => setCreateCodexAccountId(v === "__auto" ? "" : v)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__auto">自动分配</SelectItem>
                    {accountPickerOptions("codex", createCodexLevel).map((a) => {
                      const full = a.usedShares + numWeight * numCount > a.shareCapacity;
                      return (
                        <SelectItem key={a.id} value={String(a.id)} disabled={full}>
                          {a.email} ({a.usedShares}/{a.shareCapacity}份){full ? " · 份额不足" : ""}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </Field>
            )}
            {createAnti && (
              <Field className="min-w-[140px]">
                <FieldLabel>Antigravity 会员等级</FieldLabel>
                <Select value={createAntiLevel} onValueChange={setCreateAntiLevel}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择等级" />
                  </SelectTrigger>
                  <SelectContent>
                    {antiLevels.length ? (
                      antiLevels.map((lv) => (
                        <SelectItem key={lv} value={lv}>
                          {lv}
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value="__none" disabled>
                        无可用等级
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </Field>
            )}
            {createAnti && (
              <Field className="min-w-[200px]">
                <FieldLabel>Antigravity 账号(可选,默认自动)</FieldLabel>
                <Select
                  value={createAntiAccountId || "__auto"}
                  onValueChange={(v) => setCreateAntiAccountId(v === "__auto" ? "" : v)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__auto">自动分配</SelectItem>
                    {accountPickerOptions("antigravity", createAntiLevel).map((a) => {
                      const full = a.usedShares + numWeight * numCount > a.shareCapacity;
                      return (
                        <SelectItem key={a.id} value={String(a.id)} disabled={full}>
                          {a.email} ({a.usedShares}/{a.shareCapacity}份){full ? " · 份额不足" : ""}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field className="min-w-[130px]">
              <FieldLabel>份额(几人享用)</FieldLabel>
              <Select value={createWeight} onValueChange={setCreateWeight}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">拼车 · 1份(4人/号)</SelectItem>
                  <SelectItem value="2">2份(2人/号)</SelectItem>
                  <SelectItem value="4">独享 · 4份(独占一个号)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field className="min-w-[180px]">
              <FieldLabel>有效期</FieldLabel>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  min={1}
                  className="w-20"
                  value={createDurationValue}
                  onChange={(e) => setCreateDurationValue(e.target.value)}
                />
                <Select
                  value={createDurationUnit}
                  onValueChange={setCreateDurationUnit}
                >
                  <SelectTrigger className="w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="h">小时</SelectItem>
                    <SelectItem value="d">天</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </Field>
            <Field className="min-w-[130px]">
              <FieldLabel>请求数限制</FieldLabel>
              <Input
                type="number"
                min={1}
                max={5000}
                placeholder="留空不限"
                value={createLimit}
                onChange={(e) => setCreateLimit(e.target.value)}
              />
            </Field>
            <Field className="min-w-[150px]">
              <FieldLabel>Token限制</FieldLabel>
              <Input
                type="number"
                min={1}
                placeholder="留空按请求数换算"
                value={createTokenLimit}
                onChange={(e) => setCreateTokenLimit(e.target.value)}
              />
            </Field>
            <Field className="min-w-[160px]">
              <FieldLabel>限流窗口</FieldLabel>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  min={1}
                  className="w-20"
                  value={createWindowValue}
                  onChange={(e) => setCreateWindowValue(e.target.value)}
                />
                <Select
                  value={createWindowUnit}
                  onValueChange={setCreateWindowUnit}
                >
                  <SelectTrigger className="w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="h">小时</SelectItem>
                    <SelectItem value="d">天</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </Field>
            <Field className="min-w-[100px] w-24">
              <FieldLabel>生成数量</FieldLabel>
              <Input
                type="number"
                min={1}
                max={200}
                value={createCount}
                onChange={(e) => setCreateCount(e.target.value)}
              />
            </Field>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? (
                <Spinner data-icon className="size-4" />
              ) : (
                <KeyIcon data-icon className="size-4" />
              )}
              生成卡密
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Search Bar & Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">卡密列表</CardTitle>
          <div className="flex items-center gap-2">
            <Input
              className="w-64"
              placeholder="搜索卡密 / 备注 / 状态 / 设备"
              value={search}
              onChange={(e) => handleSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSearchSubmit();
                }
              }}
            />
            <Button variant="outline" size="sm" onClick={handleSearchSubmit}>
              <SearchIcon data-icon className="size-4" />
              搜索
            </Button>
            <Button variant="ghost" size="sm" onClick={handleSearchClear}>
              <XIcon data-icon className="size-4" />
              清空
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <AlertDialog open={cleanExpiredOpen} onOpenChange={setCleanExpiredOpen}>
              <Button variant="outline" size="sm" disabled={cleaningExpired} onClick={() => setCleanExpiredOpen(true)}>
                {cleaningExpired ? <Loader2Icon data-icon className="size-4 animate-spin" /> : <Trash2Icon data-icon className="size-4" />}
                清理过期
              </Button>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>清理过期卡密？</AlertDialogTitle>
                  <AlertDialogDescription>将删除状态为 expired 或已超过有效期的卡密记录，不可恢复。</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={handleCleanupExpired} disabled={cleaningExpired}>
                    {cleaningExpired && <Loader2Icon data-icon className="size-4 animate-spin" />}
                    确认清理
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <AlertDialog open={cleanUnboundOpen} onOpenChange={setCleanUnboundOpen}>
              <Button variant="outline" size="sm" disabled={cleaningUnbound} onClick={() => setCleanUnboundOpen(true)}>
                {cleaningUnbound ? <Loader2Icon data-icon className="size-4 animate-spin" /> : <UnplugIcon data-icon className="size-4" />}
                清理未绑定
              </Button>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>清理未绑定设备的卡密？</AlertDialogTitle>
                  <AlertDialogDescription>将删除所有没有绑定客户端ID的卡密记录，不可恢复。</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={handleCleanupUnbound} disabled={cleaningUnbound}>
                    {cleaningUnbound && <Loader2Icon data-icon className="size-4 animate-spin" />}
                    确认清理
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">
            共 {totalAll.toLocaleString()} 张卡密，
            {totalActive.toLocaleString()} 张有效
          </p>

          <Separator className="mb-3" />

          {/* Sort buttons */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">排序:</span>
            {(
              [
                ["recentWindowTokens", "窗口Token"],
                ["totalTokensUsed", "总Token"],
                ["totalRequests", "请求数"],
                ["anomalyCount", "异常"],
                ["createdAt", "创建时间"],
              ] as [SortField, string][]
            ).map(([field, label]) => (
              <Button
                key={field}
                variant={sortField === field ? "default" : "outline"}
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => toggleSort(field)}
              >
                {label}
                <SortIcon field={field} />
              </Button>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Spinner />
              加载中...
            </div>
          ) : keys.length === 0 ? (
            <Empty className="py-12">
              <EmptyHeader>
                <EmptyTitle>
                  {search ? "没有匹配的卡密" : "暂无卡密"}
                </EmptyTitle>
                <EmptyDescription>
                  {search
                    ? "尝试修改搜索条件"
                    : "点击上方「生成卡密」创建第一张"}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>卡密</TableHead>
                      <TableHead>备注</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>绑定账号</TableHead>
                      <TableHead>有效期</TableHead>
                      <TableHead
                        className="cursor-pointer select-none"
                        onClick={() => toggleSort("recentWindowTokens")}
                      >
                        <div className="flex items-center gap-1">
                          Token窗口
                          <SortIcon field="recentWindowTokens" />
                        </div>
                      </TableHead>
                      <TableHead
                        className="cursor-pointer select-none"
                        onClick={() => toggleSort("totalTokensUsed")}
                      >
                        <div className="flex items-center gap-1">
                          总Token
                          <SortIcon field="totalTokensUsed" />
                        </div>
                      </TableHead>
                      <TableHead
                        className="cursor-pointer select-none"
                        onClick={() => toggleSort("totalRequests")}
                      >
                        <div className="flex items-center gap-1">
                          请求数
                          <SortIcon field="totalRequests" />
                        </div>
                      </TableHead>
                      <TableHead
                        className="cursor-pointer select-none"
                        onClick={() => toggleSort("anomalyCount")}
                      >
                        <div className="flex items-center gap-1">
                          异常
                          <SortIcon field="anomalyCount" />
                        </div>
                      </TableHead>
                      <TableHead>客户端ID</TableHead>
                      <TableHead>最后使用</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageKeys.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <code className="text-xs font-mono">
                              {item.key}
                            </code>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="size-6"
                                      onClick={() =>
                                        handleCopy(item.fullKey || item.key)
                                      }
                                    />
                                  }
                                >
                                  <CopyIcon
                                    data-icon
                                    className="size-3"
                                  />
                                </TooltipTrigger>
                                <TooltipContent>复制卡密</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[120px] truncate text-sm">
                          {item.name || "-"}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(item.status)}>
                            {item.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <BindAccountControl
                            card={{ id: item.id, bindings: item.bindings, weight: item.weight }}
                            accounts={bindableAccounts}
                            onBind={(provider, accountId) => handleBind(item.id, provider, accountId)}
                            onUnbind={(provider) => handleUnbind(item.id, provider)}
                          />
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">
                          <div className="flex flex-col">
                            <span>{formatDuration(item.durationMs)}</span>
                            {item.expiresAt && (() => {
                              const remaining = new Date(item.expiresAt).getTime() - Date.now();
                              if (remaining <= 0) return <span className="text-xs text-destructive">已过期</span>;
                              const remainHours = remaining / 3600000;
                              const remainText = remainHours < 24
                                ? `剩余 ${Math.ceil(remainHours)}h`
                                : `剩余 ${Math.ceil(remainHours / 24)}d`;
                              return <span className="text-xs text-muted-foreground">{remainText}</span>;
                            })()}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">
                          <div>
                            {item.recentWindowTokens.toLocaleString()} /{" "}
                            {item.tokenWindowLimit > 0
                              ? item.tokenWindowLimit.toLocaleString()
                              : "∞"}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            每 {formatDuration(item.windowMs)}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">
                          {item.totalTokensUsed.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-sm">
                          {item.totalRequests}
                        </TableCell>
                        <TableCell className="text-sm">
                          {(() => {
                            const ac = Number(item.anomalyCount || 0);
                            if (ac === 0)
                              return (
                                <span className="text-muted-foreground">
                                  -
                                </span>
                              );
                            return (
                              <span className="flex items-center gap-1 text-destructive">
                                <AlertTriangleIcon className="size-3" />
                                {ac}
                              </span>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="max-w-[100px] truncate text-xs font-mono text-muted-foreground">
                          {item.sessionClientId || "-"}
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">
                          {formatDateTime(item.lastUsedAt)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="size-7"
                                      onClick={() => {
                                        setLimitsTarget(item);
                                        setLimitsOpen(true);
                                      }}
                                    />
                                  }
                                >
                                  <SlidersHorizontalIcon data-icon className="size-3.5" />
                                </TooltipTrigger>
                                <TooltipContent>模型限额</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="size-7"
                                      onClick={() => {
                                        setUsageTarget(item);
                                        setUsageOpen(true);
                                      }}
                                    />
                                  }
                                >
                                  <BarChart3Icon data-icon className="size-3.5" />
                                </TooltipTrigger>
                                <TooltipContent>Token 使用记录</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="size-7"
                                      onClick={() => handleToggle(item)}
                                    />
                                  }
                                >
                                  {item.status === "active" ? (
                                    <PauseIcon
                                      data-icon
                                      className="size-3.5"
                                    />
                                  ) : (
                                    <PlayIcon
                                      data-icon
                                      className="size-3.5"
                                    />
                                  )}
                                </TooltipTrigger>
                                <TooltipContent>
                                  {item.status === "active"
                                    ? "禁用"
                                    : "启用"}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="size-7"
                                      onClick={() => {
                                        setDeleteTarget(item);
                                        setDeleteOpen(true);
                                      }}
                                    />
                                  }
                                >
                                  <Trash2Icon
                                    data-icon
                                    className="size-3.5 text-destructive"
                                  />
                                </TooltipTrigger>
                                <TooltipContent>删除</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="mt-4 flex items-center justify-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentPage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    上一页
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {currentPage} / {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentPage >= totalPages}
                    onClick={() =>
                      setPage((p) => Math.min(totalPages, p + 1))
                    }
                  >
                    下一页
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Key Reveal Dialog */}
      <Dialog open={revealOpen} onOpenChange={setRevealOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>卡密已生成</DialogTitle>
            <DialogDescription>
              {revealKeys.length > 1
                ? `共生成 ${revealKeys.length} 张卡密，已自动复制到剪贴板。`
                : "请立即复制此卡密，关闭后将无法再次查看完整卡密。"}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-60 overflow-y-auto rounded-lg border bg-muted/50 p-3">
            <code className="block break-all text-sm font-mono whitespace-pre-wrap">
              {revealKeys.join("\n")}
            </code>
          </div>
          <DialogFooter>
            <Button
              onClick={async () => {
                await navigator.clipboard
                  ?.writeText(revealKeys.join("\n"))
                  .catch(() => {});
                toast.success("已复制到剪贴板");
              }}
            >
              <CopyIcon data-icon className="size-3.5" />
              复制卡密
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Token Usage Detail */}
      <CardUsageDialog
        card={usageTarget}
        open={usageOpen}
        onOpenChange={setUsageOpen}
      />

      {/* Card Limits Dialog */}
      <CardLimitsDialog
        card={limitsTarget}
        open={limitsOpen}
        onOpenChange={setLimitsOpen}
        onSaved={() => fetchKeys()}
      />

      {/* Delete Confirmation */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除该卡密？删除后不可恢复。
              {deleteTarget && (
                <code className="mt-1 block text-xs font-mono">
                  {deleteTarget.key}
                  {deleteTarget.name ? ` (${deleteTarget.name})` : ""}
                </code>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Spinner data-icon className="size-4" />}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
