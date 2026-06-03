"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Plus, Power, Trash2, RefreshCw, Copy, Search,
  Download, FolderOpen, Users, UserCheck, UserX, KeyRound, Gauge,
  SlidersHorizontal, ExternalLinkIcon, GitMerge,
} from "lucide-react";
import {
  CANONICAL_MODELS, resolveCanonicalModel, quotaBarColor,
} from "../rosetta-load/constants";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import { Field, FieldLabel } from "@/components/ui/field";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Pagination, PaginationContent, PaginationEllipsis, PaginationItem,
  PaginationLink, PaginationNext, PaginationPrevious,
} from "@/components/ui/pagination";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup,
  DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

type RosettaAccount = {
  id: string;
  email: string;
  enabled: boolean;
  poolEnabled: boolean;
  alias?: string;
  projectId?: string;
  planType?: string;
  oauthProfile?: string;
  hasToken?: boolean;
  boundCardCount?: number;
  usedShares?: number;
  shareCapacity?: number;
  familyRole?: string;
  familyStatus?: string;
  motherId?: string;
  seatId?: string;
  modelQuotaFractions?: Record<string, number>;
  modelQuotaResetTimes?: Record<string, string>;
  modelQuotaRefreshedAt?: number;
};

// ── Model quota helpers ──
const GEMINI_IDS = new Set(CANONICAL_MODELS.filter((m) => m.id.startsWith("gemini-")).map((m) => m.id));
const CLAUDE_IDS = new Set(CANONICAL_MODELS.filter((m) => m.id.startsWith("claude-")).map((m) => m.id));

function aggregatePoolFraction(
  fractions: Record<string, number> | undefined,
  poolIds: Set<string>,
): number | null {
  if (!fractions) return null;
  const vals: number[] = [];
  for (const [key, val] of Object.entries(fractions)) {
    const canonical = resolveCanonicalModel(key);
    if (canonical && poolIds.has(canonical.id)) vals.push(val);
  }
  if (vals.length === 0) return null;
  return Math.round(Math.min(...vals) * 100);
}

function CompactQuotaCell({ account }: { account: RosettaAccount }) {
  const gemini = aggregatePoolFraction(account.modelQuotaFractions, GEMINI_IDS);
  const claude = aggregatePoolFraction(account.modelQuotaFractions, CLAUDE_IDS);
  if (gemini === null && claude === null) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col gap-0.5">
      {gemini !== null && (
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-medium w-3 shrink-0">G</span>
          <div className="h-1.5 w-11 rounded-full bg-muted overflow-hidden">
            <div className={`h-full rounded-full ${quotaBarColor(gemini)}`} style={{ width: `${gemini}%` }} />
          </div>
          <span className={`text-[10px] tabular-nums font-semibold ${gemini > 60 ? "text-emerald-500" : gemini > 25 ? "text-amber-500" : "text-red-500"}`}>{gemini}%</span>
        </div>
      )}
      {claude !== null && (
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-medium w-3 shrink-0">C</span>
          <div className="h-1.5 w-11 rounded-full bg-muted overflow-hidden">
            <div className={`h-full rounded-full ${quotaBarColor(claude)}`} style={{ width: `${claude}%` }} />
          </div>
          <span className={`text-[10px] tabular-nums font-semibold ${claude > 60 ? "text-emerald-500" : claude > 25 ? "text-amber-500" : "text-red-500"}`}>{claude}%</span>
        </div>
      )}
    </div>
  );
}

const ALL_COLUMNS = [
  { key: "id", label: "ID" },
  { key: "email", label: "Email" },
  { key: "planType", label: "套餐" },
  { key: "modelQuota", label: "模型额度" },
  { key: "alias", label: "别名" },
  { key: "projectId", label: "ProjectId" },
  { key: "oauthProfile", label: "OAuth Profile" },
  { key: "familyRole", label: "Family 角色" },
  { key: "familyStatus", label: "Family 状态" },
  { key: "token", label: "Token" },
  { key: "boundCard", label: "份额用量" },
  { key: "status", label: "状态" },
  { key: "motherId", label: "Mother ID" },
  { key: "seatId", label: "Seat ID" },
] as const;

const DEFAULT_VISIBLE = new Set([
  "email", "planType", "modelQuota", "token", "boundCard", "status",
]);

const PAGE_SIZE = 20;

export default function RosettaAccountsPage() {
  const [accounts, setAccounts] = useState<RosettaAccount[]>([]);
  const [dataDir, setDataDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("rosetta-accounts-visible-cols");
        if (saved) {
          const arr = JSON.parse(saved) as string[];
          if (Array.isArray(arr) && arr.length > 0) return new Set(arr);
        }
      } catch { /* ignore */ }
    }
    return new Set(DEFAULT_VISIBLE);
  });
  useEffect(() => {
    try {
      localStorage.setItem("rosetta-accounts-visible-cols", JSON.stringify([...visibleCols]));
    } catch { /* ignore */ }
  }, [visibleCols]);

  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({
    email: "", refreshToken: "", alias: "", projectId: "", oauthProfile: "antigravity",
  });
  const [addSubmitting, setAddSubmitting] = useState(false);

  const [togglingId, setTogglingId] = useState<string | null>(null);
  // 手动「刷新」(刷 token + 拉额度,一个动作)进行中的账号 id。
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  // Google OAuth state
  const [oauthStarting, setOauthStarting] = useState(false);
  const [oauthLoginId, setOauthLoginId] = useState("");
  const [oauthStatusText, setOauthStatusText] = useState("");
  const [oauthAuthUrl, setOauthAuthUrl] = useState("");
  const [oauthCallbackInput, setOauthCallbackInput] = useState("");
  const [oauthSubmitting, setOauthSubmitting] = useState(false);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const [accountsRes, statusRes] = await Promise.all([
        fetch("/api/rosetta/accounts"),
        fetch("/api/remote-token/status").catch(() => null),
      ]);
      const data = await accountsRes.json();
      if (!data.ok) throw new Error(data.error || "加载失败");

      // Merge model quota data from token-server status
      let quotaMap = new Map<number, { fractions?: Record<string, number>; resetTimes?: Record<string, string>; refreshedAt?: number }>();
      if (statusRes?.ok) {
        try {
          const statusData = await statusRes.json();
          for (const qa of statusData?.quota?.accounts || []) {
            quotaMap.set(Number(qa.id), {
              fractions: qa.modelQuotaFractions,
              resetTimes: qa.modelQuotaResetTimes,
              refreshedAt: qa.modelQuotaRefreshedAt,
            });
          }
        } catch { /* ignore status parse error */ }
      }

      const merged = (data.accounts || []).map((a: RosettaAccount) => {
        const q = quotaMap.get(Number(a.id));
        return q ? { ...a, modelQuotaFractions: q.fractions, modelQuotaResetTimes: q.resetTimes, modelQuotaRefreshedAt: q.refreshedAt } : a;
      });

      // Sort: plan tier priority → Claude quota desc → no quota last
      const PLAN_ORDER: Record<string, number> = { ultra: 0, premium: 1, antigravity: 2, free: 3 };
      merged.sort((a: RosettaAccount, b: RosettaAccount) => {
        const pa = PLAN_ORDER[a.planType || ""] ?? 2.5;
        const pb = PLAN_ORDER[b.planType || ""] ?? 2.5;
        if (pa !== pb) return pa - pb;
        const ca = aggregatePoolFraction(a.modelQuotaFractions, CLAUDE_IDS);
        const cb = aggregatePoolFraction(b.modelQuotaFractions, CLAUDE_IDS);
        if (ca === null && cb === null) return 0;
        if (ca === null) return 1;
        if (cb === null) return -1;
        return cb - ca;
      });
      setAccounts(merged);
      setDataDir(data.dataDir || "");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载账号失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const term = query.trim().toLowerCase();
  const filtered = useMemo(() =>
    accounts.filter((a) => {
      if (!term) return true;
      return [a.email, a.alias, a.projectId, a.planType]
        .some((v) => String(v || "").toLowerCase().includes(term));
    }),
    [accounts, term],
  );

  const enabledCount = accounts.filter((a) => a.enabled).length;
  const disabledCount = accounts.length - enabledCount;
  const tokenCount = accounts.filter((a) => a.hasToken).length;

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const pageSelectedIds = useMemo(
    () => new Set(paginated.filter((a) => selectedIds.has(a.id)).map((a) => a.id)),
    [paginated, selectedIds],
  );
  const allPageSelected = paginated.length > 0 && pageSelectedIds.size === paginated.length;
  const somePageSelected = pageSelectedIds.size > 0 && !allPageSelected;

  function toggleColumn(key: string) {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        for (const a of paginated) next.delete(a.id);
      } else {
        for (const a of paginated) next.add(a.id);
      }
      return next;
    });
  }

  function toggleSelectOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!addForm.email.trim() || !addForm.refreshToken.trim()) {
      toast.error("Email 和 Refresh Token 为必填项");
      return;
    }
    setAddSubmitting(true);
    try {
      const res = await fetch("/api/rosetta/add-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: addForm.email.trim(),
          refreshToken: addForm.refreshToken.trim(),
          alias: addForm.alias.trim() || undefined,
          projectId: addForm.projectId.trim() || undefined,
          oauthProfile: addForm.oauthProfile.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "添加失败");
      toast.success(data.isUpdate ? `已更新 ${data.email}` : `已添加 ${data.email}，共 ${data.totalAccounts} 个账号`);
      setAddForm({ email: "", refreshToken: "", alias: "", projectId: "", oauthProfile: "antigravity" });
      setAddOpen(false);
      await loadAccounts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "添加账号失败");
    } finally {
      setAddSubmitting(false);
    }
  }

  async function handleOAuthStart() {
    setOauthStarting(true);
    try {
      const res = await fetch("/api/rosetta/google-oauth-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oauthProfile: "antigravity" }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Google OAuth start failed");
      setOauthLoginId(data.loginId);
      setOauthAuthUrl(data.authUrl || "");
      setOauthCallbackInput("");
      setOauthStatusText("");
      window.open(data.authUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Google OAuth start failed");
      setOauthLoginId("");
      setOauthAuthUrl("");
      setOauthStatusText("");
    } finally {
      setOauthStarting(false);
    }
  }

  async function handleOAuthSubmit() {
    const input = oauthCallbackInput.trim();
    if (!input) {
      toast.error("请粘贴授权后跳转的回调 URL 或其中的 code");
      return;
    }
    setOauthSubmitting(true);
    setOauthStatusText("");
    try {
      const res = await fetch("/api/rosetta/google-oauth-submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId: oauthLoginId, input }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "完成授权失败");
      toast.success(data.isUpdate ? `OAuth 已更新 ${data.email}` : `OAuth 已添加 ${data.email}`);
      setOauthLoginId("");
      setOauthAuthUrl("");
      setOauthCallbackInput("");
      setOauthStatusText("");
      loadAccounts();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "完成授权失败";
      setOauthStatusText(msg);
      toast.error(msg);
    } finally {
      setOauthSubmitting(false);
    }
  }

  async function handleOAuthCancel() {
    const loginId = oauthLoginId;
    setOauthLoginId("");
    setOauthStatusText("");
    setOauthAuthUrl("");
    setOauthCallbackInput("");
    if (!loginId) return;
    try {
      await fetch("/api/rosetta/google-oauth-cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId }),
      });
    } catch {
      // Best-effort cleanup
    }
  }

  async function handleToggle(accountId: string) {
    setTogglingId(accountId);
    try {
      const res = await fetch("/api/rosetta/toggle-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "切换失败");
      toast.success(`${data.email} 已${data.enabled ? "启用" : "禁用"}`);
      setAccounts((prev) =>
        prev.map((a) => a.id === accountId ? { ...a, enabled: data.enabled } : a),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "切换状态失败");
    } finally {
      setTogglingId(null);
    }
  }

  async function handleTogglePool(accountId: string) {
    setTogglingId(accountId);
    try {
      const res = await fetch("/api/rosetta/toggle-account-pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "切换失败");
      toast.success(`${data.email} ${data.poolEnabled ? "已入池" : "已出池"}（${data.poolEnabled ? "允许池轮询" : "仅绑定卡可用"}）`);
      setAccounts((prev) =>
        prev.map((a) => a.id === accountId ? { ...a, poolEnabled: data.poolEnabled } : a),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "切换入池状态失败");
    } finally {
      setTogglingId(null);
    }
  }

  // 「刷新」= 强制刷 token + 拉额度(后端一个接口)。
  async function handleRefresh(accountId: string) {
    setBusyId(accountId);
    try {
      const res = await fetch("/api/rosetta/refresh-account-quota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "刷新失败");
      toast.success(`${data.email} 已刷新${data.planType ? `(${data.planType})` : ""}`);
      loadAccounts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刷新失败");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(accountId: string) {
    try {
      const res = await fetch("/api/rosetta/delete-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "删除失败");
      toast.success(`已删除，剩余 ${data.totalAccounts} 个账号`);
      setAccounts((prev) => prev.filter((a) => a.id !== accountId));
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(accountId); return next; });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除账号失败");
    }
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    setBulkDeleting(true);
    const ids = [...selectedIds];
    let successCount = 0;
    for (const id of ids) {
      try {
        const res = await fetch("/api/rosetta/delete-account", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: id }),
        });
        const data = await res.json();
        if (data.ok) successCount++;
      } catch { /* skip */ }
    }
    toast.success(`批量删除完成，成功 ${successCount}/${ids.length}`);
    setSelectedIds(new Set());
    setBulkDeleteOpen(false);
    setBulkDeleting(false);
    await loadAccounts();
  }

  function handleBulkExport() {
    const selected = accounts.filter((a) => selectedIds.has(a.id));
    if (selected.length === 0) { toast.error("未选择任何账号"); return; }
    const json = JSON.stringify(selected, null, 2);
    navigator.clipboard.writeText(json).then(
      () => toast.success(`已复制 ${selected.length} 个账号到剪贴板`),
      () => toast.error("复制失败"),
    );
  }

  function copyEmail(email: string) {
    navigator.clipboard.writeText(email).then(
      () => toast.success(`已复制 ${email}`),
      () => toast.error("复制失败"),
    );
  }

  function renderCellContent(account: RosettaAccount, colKey: string) {
    switch (colKey) {
      case "id":
        return (
          <Tooltip>
            <TooltipTrigger className="truncate block max-w-[80px]">
              {String(account.id).slice(0, 6)}
            </TooltipTrigger>
            <TooltipContent>{account.id}</TooltipContent>
          </Tooltip>
        );
      case "email":
        return (
          <Tooltip>
            <TooltipTrigger
              className="font-mono text-xs cursor-pointer hover:text-primary transition-colors"
              onClick={() => copyEmail(account.email)}
            >
              {account.email}
            </TooltipTrigger>
            <TooltipContent>
              <span className="flex items-center gap-1"><Copy className="size-3" />点击复制</span>
            </TooltipContent>
          </Tooltip>
        );
      case "modelQuota":
        return <CompactQuotaCell account={account} />;
      case "alias":
        return account.alias || "-";
      case "projectId":
        return <span className="font-mono text-xs">{account.projectId || "-"}</span>;
      case "planType":
        return account.planType || "-";
      case "oauthProfile":
        return <span className="max-w-[120px] truncate block">{account.oauthProfile || "-"}</span>;
      case "familyRole":
        return account.familyRole || "-";
      case "familyStatus":
        return account.familyStatus || "-";
      case "token":
        return (
          <Badge variant={account.hasToken ? "default" : "secondary"} className={account.hasToken ? "bg-emerald-600 hover:bg-emerald-700" : "text-red-500"}>
            {account.hasToken ? "有" : "无"}
          </Badge>
        );
      case "boundCard": {
        const cap = Number(account.shareCapacity || 4);
        const used = Number(account.usedShares || 0);
        return (
          <Badge variant={used >= cap ? "destructive" : "secondary"}>
            {used}/{cap} 份
          </Badge>
        );
      }
      case "status":
        return (
          <Badge variant={account.enabled ? "default" : "secondary"}>
            {account.enabled ? "启用" : "禁用"}
          </Badge>
        );
      case "motherId":
        return <span className="font-mono text-xs">{account.motherId || "-"}</span>;
      case "seatId":
        return <span className="font-mono text-xs">{account.seatId || "-"}</span>;
      default:
        return "-";
    }
  }

  function getHeadClassName(colKey: string) {
    switch (colKey) {
      case "id": return "w-16";
      case "modelQuota": return "w-[110px]";
      case "token": return "text-center";
      case "status": return "text-center";
      default: return "";
    }
  }

  function getCellClassName(colKey: string) {
    switch (colKey) {
      case "id": return "font-mono text-xs max-w-[80px] truncate";
      case "email": return "";
      case "alias": return "text-sm";
      case "planType": return "text-xs";
      case "oauthProfile": return "text-xs";
      case "familyRole": return "text-xs";
      case "familyStatus": return "text-xs";
      case "token": return "text-center";
      case "status": return "text-center";
      default: return "";
    }
  }

  function renderPagination() {
    if (totalPages <= 1) return null;
    const pages: (number | "e")[] = [];
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) pages.push(i);
      else if (pages[pages.length - 1] !== "e") pages.push("e");
    }
    return (
      <Pagination className="mt-4">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              text="上一页"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              className={currentPage <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
            />
          </PaginationItem>
          {pages.map((p, idx) =>
            p === "e" ? (
              <PaginationItem key={`e-${idx}`}><PaginationEllipsis /></PaginationItem>
            ) : (
              <PaginationItem key={p}>
                <PaginationLink isActive={p === currentPage} onClick={() => setCurrentPage(p)} className="cursor-pointer">
                  {p}
                </PaginationLink>
              </PaginationItem>
            ),
          )}
          <PaginationItem>
            <PaginationNext
              text="下一页"
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              className={currentPage >= totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold">Antigravity 账号池</h1>
        <p className="text-sm text-muted-foreground">
          管理 Rosetta 代理池中的 Google 账号。
          {dataDir && (
            <span className="inline-flex items-center gap-1 ml-2">
              <FolderOpen className="size-3 inline" />
              数据目录: {dataDir}
            </span>
          )}
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">总账号</CardTitle>
            <Users className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{accounts.length}</CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">已启用</CardTitle>
            <UserCheck className="size-4 text-emerald-500" />
          </CardHeader>
          <CardContent className="text-2xl font-semibold text-emerald-600">{enabledCount}</CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">已禁用</CardTitle>
            <UserX className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="text-2xl font-semibold text-muted-foreground">{disabledCount}</CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">有 Token</CardTitle>
            <KeyRound className="size-4 text-amber-500" />
          </CardHeader>
          <CardContent className="text-2xl font-semibold text-amber-600">{tokenCount}</CardContent>
        </Card>
      </div>

      {/* Main Table Card */}
      <Card>
        <CardHeader className="flex flex-col gap-3">
          {/* Toolbar */}
          <div className="flex items-center gap-3">
            {/* Left group: search + count */}
            <div className="flex items-center gap-2 flex-1">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="w-64 pl-8"
                  placeholder="搜索邮箱 / 别名 / ProjectId / 套餐"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setCurrentPage(1); }}
                />
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {filtered.length} / {accounts.length} 条
                {totalPages > 1 && ` · 第 ${currentPage}/${totalPages} 页`}
              </span>
            </div>

            <Separator orientation="vertical" className="h-5" />

            {/* Middle group: column settings */}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="icon" />}>
                <SlidersHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>显示列</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {ALL_COLUMNS.map((col) => (
                    <DropdownMenuCheckboxItem
                      key={col.key}
                      checked={visibleCols.has(col.key)}
                      onCheckedChange={() => toggleColumn(col.key)}
                    >
                      {col.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <Separator orientation="vertical" className="h-5" />

            {/* Right group: refresh + add */}
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleOAuthStart} disabled={oauthStarting || Boolean(oauthLoginId)}>
                {oauthStarting ? <Spinner size={14} /> : <ExternalLinkIcon className="size-4" />}
                OAuth 登录
              </Button>
              <Button variant="outline" size="icon" onClick={loadAccounts} disabled={loading}>
                <RefreshCw className={loading ? "animate-spin" : ""} />
              </Button>
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus data-icon="inline-start" />添加账号
              </Button>
            </div>
          </div>

          {/* Batch actions bar */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2">
              <Badge variant="secondary">已选 {selectedIds.size} 项</Badge>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setBulkDeleteOpen(true)}
              >
                <Trash2 data-icon="inline-start" />批量删除
              </Button>
              <Button variant="outline" size="sm" onClick={handleBulkExport}>
                <Download data-icon="inline-start" />导出选中
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedIds(new Set())}
              >
                清除选择
              </Button>
            </div>
          )}
        </CardHeader>

        {oauthLoginId ? (
          <div className="mx-6 mb-4 flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm">
            <div className="space-y-1">
              <p className="font-medium">完成 Google OAuth 登录</p>
              <p className="text-muted-foreground">
                1. 在新打开的页面完成 Google 授权（没弹出的话，
                {oauthAuthUrl ? (
                  <a href={oauthAuthUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">点此打开授权页</a>
                ) : "请重新发起"}
                ）。
              </p>
              <p className="text-muted-foreground">
                2. 授权后浏览器会跳到 <code className="rounded bg-muted px-1">localhost:1456/auth/callback?...</code>（页面打不开是正常的），把<strong>整个地址栏 URL</strong> 复制粘贴到下面，点「完成授权」。
              </p>
            </div>
            <Textarea
              rows={3}
              placeholder="http://localhost:1456/auth/callback?code=...&state=..."
              value={oauthCallbackInput}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setOauthCallbackInput(e.target.value)}
            />
            {oauthStatusText ? <p className="text-destructive">{oauthStatusText}</p> : null}
            <div className="flex gap-2">
              <Button size="sm" onClick={handleOAuthSubmit} disabled={oauthSubmitting}>
                {oauthSubmitting ? <Spinner size={14} /> : null}
                完成授权
              </Button>
              <Button size="sm" variant="outline" onClick={handleOAuthCancel} disabled={oauthSubmitting}>取消</Button>
            </div>
          </div>
        ) : null}

        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
              <Spinner />
              <span className="text-sm">加载中...</span>
            </div>
          ) : paginated.length === 0 ? (
            <Empty className="py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Search /></EmptyMedia>
                <EmptyTitle>{term ? "没有匹配的账号" : "暂无账号"}</EmptyTitle>
                <EmptyDescription>
                  {term ? "尝试修改搜索关键词" : "点击「添加账号」添加第一个账号"}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allPageSelected}
                          indeterminate={somePageSelected}
                          onCheckedChange={toggleSelectAll}
                        />
                      </TableHead>
                      {ALL_COLUMNS.filter((col) => visibleCols.has(col.key)).map((col) => (
                        <TableHead key={col.key} className={getHeadClassName(col.key)}>
                          {col.label}
                        </TableHead>
                      ))}
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginated.map((account) => (
                      <TableRow key={account.id} data-state={selectedIds.has(account.id) ? "selected" : undefined}>
                        <TableCell>
                          <Checkbox
                            checked={selectedIds.has(account.id)}
                            onCheckedChange={() => toggleSelectOne(account.id)}
                          />
                        </TableCell>
                        {ALL_COLUMNS.filter((col) => visibleCols.has(col.key)).map((col) => (
                          <TableCell key={col.key} className={getCellClassName(col.key)}>
                            {renderCellContent(account, col.key)}
                          </TableCell>
                        ))}
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    disabled={togglingId === account.id}
                                    onClick={() => void handleToggle(account.id)}
                                  />
                                }
                              >
                                {togglingId === account.id
                                  ? <Spinner className="size-3.5" />
                                  : <Power className={`size-3.5 ${account.enabled ? "text-emerald-500" : "text-muted-foreground"}`} />}
                              </TooltipTrigger>
                              <TooltipContent>{account.enabled ? "禁用" : "启用"}</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    disabled={togglingId === account.id}
                                    onClick={() => void handleTogglePool(account.id)}
                                  />
                                }
                              >
                                <GitMerge className={`size-3.5 ${account.poolEnabled ? "text-blue-500" : "text-muted-foreground"}`} />
                              </TooltipTrigger>
                              <TooltipContent>{account.poolEnabled ? "已入池（点击出池）" : "已出池（点击入池）"}</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    disabled={busyId === account.id}
                                    onClick={() => void handleRefresh(account.id)}
                                  />
                                }
                              >
                                {busyId === account.id
                                  ? <Spinner className="size-3.5" />
                                  : <Gauge className="size-3.5" />}
                              </TooltipTrigger>
                              <TooltipContent>刷新 token + 获取额度</TooltipContent>
                            </Tooltip>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="text-destructive"
                              onClick={() => setDeleteTarget(account)}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {renderPagination()}
            </>
          )}
        </CardContent>
      </Card>

      {/* Add Account Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>添加账号</DialogTitle>
            <DialogDescription>添加一个 Google 账号到 Rosetta 代理池。</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAdd} className="flex flex-col gap-4">
            <Field>
              <FieldLabel>Email *</FieldLabel>
              <Input
                type="email"
                required
                placeholder="example@gmail.com"
                value={addForm.email}
                onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
              />
            </Field>
            <Field>
              <FieldLabel>Refresh Token *</FieldLabel>
              <Textarea
                required
                placeholder="1//0e..."
                rows={3}
                value={addForm.refreshToken}
                onChange={(e) => setAddForm((f) => ({ ...f, refreshToken: e.target.value }))}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel>别名</FieldLabel>
                <Input
                  placeholder="可选"
                  value={addForm.alias}
                  onChange={(e) => setAddForm((f) => ({ ...f, alias: e.target.value }))}
                />
              </Field>
              <Field>
                <FieldLabel>Project ID</FieldLabel>
                <Input
                  placeholder="可选"
                  value={addForm.projectId}
                  onChange={(e) => setAddForm((f) => ({ ...f, projectId: e.target.value }))}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel>OAuth Profile</FieldLabel>
              <Input
                placeholder="antigravity"
                value={addForm.oauthProfile}
                onChange={(e) => setAddForm((f) => ({ ...f, oauthProfile: e.target.value }))}
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>取消</Button>
              <Button type="submit" disabled={addSubmitting}>
                {addSubmitting && <Spinner data-icon="inline-start" />}
                添加
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirm */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>批量删除确认</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除选中的 <strong>{selectedIds.size}</strong> 个账号吗？此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleBulkDelete()}
              disabled={bulkDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {bulkDeleting && <Spinner data-icon="inline-start" />}
              确认删除 {selectedIds.size} 项
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Single Delete Confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除？</AlertDialogTitle>
            <AlertDialogDescription>
              删除账号 <strong>{deleteTarget?.email}</strong>？此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) void handleDelete(deleteTarget.id);
                setDeleteTarget(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
