"use client";

// 卡密管理页(rosetta-keys)—— 瘦容器(对应设计 §7 的拆分目标:取代旧 1425 行大文件)。
// 职责仅限「取数 + UI 状态编排 + 行操作回调」,具体渲染全部委托给子组件:
//   - 取数:use-access-keys(列表 + 刷新)、use-lease-accounts(选号下拉 + 份额校验)。
//   - 渲染:toolbar(工具栏)+ key-table(精简 5 列表格 + 行展开)。
//   - 弹窗:create-wizard(新增向导)、card-edit-dialog(编辑)、card-usage-dialog(用量)。
// 行操作回调:编辑(开 edit dialog)/ 用量(开 usage dialog)/ 启停(直接切 status 调
//   access-key-update,乐观更新 + 失败回滚)/ 删除(AlertDialog 二次确认)/ 复制。
// 搜索:输入受控 + 提交时透传给后端做服务端过滤;类型/状态筛选、排序、分页在本地内存做。
// 清理(过期 / 未绑定):用 AlertDialog 二次确认后调对应清理接口。

import { useCallback, useMemo, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { useAccessKeys } from "./use-access-keys";
import { useLeaseAccounts } from "./use-lease-accounts";
import {
  Toolbar,
  type OverviewCounts,
  type SortDir,
  type SortField,
  type StatusFilter,
  type TypeFilter,
} from "./toolbar";
import { KeyTable } from "./key-table";
import { CreateWizard } from "./create-wizard";
import { CardEditDialog } from "./card-edit-dialog";
import { CardUsageDialog } from "./card-usage-dialog";
import type { AccessKeyListItem } from "./types";

// 本地分页每页条数(与旧实现一致)。
const PAGE_SIZE = 20;
// 「7 天内到期」阈值(毫秒)。
const SEVEN_DAYS_MS = 7 * 86_400_000;

/** 判断一张卡是否「已过期」(有 expiresAt 且已过当前时刻)。 */
function isExpired(key: AccessKeyListItem): boolean {
  if (!key.expiresAt) return false;
  return new Date(key.expiresAt).getTime() <= Date.now();
}

/** 判断一张卡是否「7 天内到期」(有 expiresAt 且剩余 0..7d)。 */
function isExpiringSoon(key: AccessKeyListItem): boolean {
  if (!key.expiresAt) return false;
  const remaining = new Date(key.expiresAt).getTime() - Date.now();
  return remaining > 0 && remaining <= SEVEN_DAYS_MS;
}

/** 状态筛选匹配:expired 需把「status=expired」与「已超期的非禁用卡」都算进去。 */
function matchStatus(key: AccessKeyListItem, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "expired") return key.status === "expired" || isExpired(key);
  if (filter === "disabled") return key.status === "disabled";
  // active:状态为 active 且未超期。
  return key.status === "active" && !isExpired(key);
}

export default function RosettaKeysPage() {
  // ── 取数 ──
  // 已提交的搜索词(透传后端);输入框的即时值单独存,Enter/按钮时才提交。
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const { keys, loading, error, refresh } = useAccessKeys(submittedSearch);
  const { accounts, refresh: refreshAccounts } = useLeaseAccounts();

  // ── 筛选 / 排序 / 分页(本地内存)──
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);

  // ── 弹窗 / 操作状态 ──
  const [createOpen, setCreateOpen] = useState(false);
  const [editCard, setEditCard] = useState<AccessKeyListItem | null>(null);
  const [usageCard, setUsageCard] = useState<AccessKeyListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AccessKeyListItem | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  // 清理二次确认:null = 关闭;否则记录清理类型。
  const [cleanupKind, setCleanupKind] = useState<"expired" | "unbound" | null>(
    null,
  );
  const [cleaning, setCleaning] = useState(false);

  // 操作后统一刷新:列表 + 账号份额(换绑/删卡都可能改变账号 usedShares)。
  const refreshAll = useCallback(() => {
    void refresh();
    void refreshAccounts();
  }, [refresh, refreshAccounts]);

  // ── 概览 chips 计数(基于完整列表,不受筛选影响)──
  const counts: OverviewCounts = useMemo(() => {
    let active = 0;
    let expiringSoon = 0;
    let inactive = 0;
    for (const k of keys) {
      const expired = isExpired(k);
      if (k.status === "active" && !expired) active += 1;
      if (isExpiringSoon(k)) expiringSoon += 1;
      if (k.status === "disabled" || k.status === "expired" || expired)
        inactive += 1;
    }
    return { total: keys.length, active, expiringSoon, inactive };
  }, [keys]);

  // ── 筛选 + 排序后的完整结果(分页前)──
  const filtered = useMemo(() => {
    const result = keys.filter((k) => {
      if (typeFilter !== "all" && k.cardType !== typeFilter) return false;
      if (!matchStatus(k, statusFilter)) return false;
      return true;
    });
    // 排序:时间字段按时间戳,其余按数值;空到期时间排末尾。
    const dir = sortDir === "asc" ? 1 : -1;
    result.sort((a, b) => {
      let av: number;
      let bv: number;
      if (sortField === "createdAt" || sortField === "expiresAt") {
        av = a[sortField] ? new Date(a[sortField]).getTime() : 0;
        bv = b[sortField] ? new Date(b[sortField]).getTime() : 0;
      } else {
        av = Number(a[sortField] || 0);
        bv = Number(b[sortField] || 0);
      }
      return (av - bv) * dir;
    });
    return result;
  }, [keys, typeFilter, statusFilter, sortField, sortDir]);

  // ── 分页(夹取页码 + 切出当前页)──
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  );

  // 是否处于「有筛选/搜索」状态(空态文案区分用)。
  const hasActiveFilter =
    Boolean(submittedSearch) || typeFilter !== "all" || statusFilter !== "all";

  // 任一筛选/排序变更后回到第一页。
  const resetToFirstPage = () => setPage(1);

  // ── 搜索 ──
  const submitSearch = () => {
    setSubmittedSearch(searchInput.trim());
    resetToFirstPage();
  };
  const clearSearch = () => {
    setSearchInput("");
    setSubmittedSearch("");
    resetToFirstPage();
  };

  // ── 行操作:复制 ──
  const handleCopy = useCallback(async (value: string) => {
    if (!value) {
      toast.error("卡密为空");
      return;
    }
    await navigator.clipboard?.writeText(value).catch(() => {});
    toast.success("卡密已复制");
  }, []);

  // ── 行操作:启停(直接切换 status,失败 refetch 回滚)──
  const handleToggle = useCallback(
    async (key: AccessKeyListItem) => {
      const next = key.status === "active" ? "disabled" : "active";
      try {
        const res = await fetch("/api/console/rosetta/access-key-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: key.id, status: next }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "操作失败");
        toast.success(next === "active" ? "卡密已启用" : "卡密已禁用");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "操作失败");
      } finally {
        // 无论成败都刷新:成功落地新状态;失败则回滚到服务端真值。
        void refresh();
      }
    },
    [refresh],
  );

  // ── 行操作:删除(AlertDialog 确认后执行)──
  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/console/rosetta/access-key-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteTarget.id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "删除失败");
      toast.success("卡密已删除");
      setDeleteTarget(null);
      refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, refreshAll]);

  // ── 清理(过期 / 未绑定):AlertDialog 确认后执行 ──
  const handleCleanupConfirm = useCallback(async () => {
    if (!cleanupKind) return;
    setCleaning(true);
    const path =
      cleanupKind === "expired"
        ? "/api/console/rosetta/cleanup-expired-keys"
        : "/api/console/rosetta/cleanup-unbound-keys";
    const label = cleanupKind === "expired" ? "过期" : "未绑定设备的";
    try {
      const res = await fetch(path, { method: "POST" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "清理失败");
      toast.success(
        Number(data.deleted) > 0
          ? `已清理 ${data.deleted} 条${label}卡密`
          : `没有需要清理的${label}卡密`,
      );
      setCleanupKind(null);
      refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "清理失败");
    } finally {
      setCleaning(false);
    }
  }, [cleanupKind, refreshAll]);

  return (
    <div className="flex flex-col gap-4">
      {/* 页头 */}
      <div>
        <h1 className="text-2xl font-semibold">卡密管理</h1>
        <p className="text-sm text-muted-foreground">
          生成卡密、查看有效期与 token 用量。有效期从第一次使用开始计算。
        </p>
      </div>

      {/* 工具栏:搜索 / 筛选 / 排序 / 概览 / 清理 / 生成 */}
      <Toolbar
        search={searchInput}
        onSearchChange={setSearchInput}
        onSearchSubmit={submitSearch}
        onSearchClear={clearSearch}
        typeFilter={typeFilter}
        onTypeFilterChange={(v) => {
          setTypeFilter(v);
          resetToFirstPage();
        }}
        statusFilter={statusFilter}
        onStatusFilterChange={(v) => {
          setStatusFilter(v);
          resetToFirstPage();
        }}
        sortField={sortField}
        sortDir={sortDir}
        onSortFieldChange={(v) => {
          setSortField(v);
          resetToFirstPage();
        }}
        onSortDirToggle={() =>
          setSortDir((d) => (d === "desc" ? "asc" : "desc"))
        }
        counts={counts}
        onCleanupExpired={() => setCleanupKind("expired")}
        onCleanupUnbound={() => setCleanupKind("unbound")}
        cleaning={cleaning}
        onCreate={() => setCreateOpen(true)}
      />

      {/* 错误条:toast 之外再给一个内联重试入口 */}
      {error && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
          >
            重试
          </Button>
        </div>
      )}

      {/* 列表:加载中显示 spinner,否则渲染表格 */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Spinner />
          加载中...
        </div>
      ) : (
        <>
          <KeyTable
            keys={pageItems}
            hasActiveFilter={hasActiveFilter}
            onCopy={handleCopy}
            onEdit={setEditCard}
            onUsage={setUsageCard}
            onToggle={handleToggle}
            onDelete={setDeleteTarget}
          />

          {/* 分页 */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </Button>
              <span className="text-sm text-muted-foreground">
                {safePage} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                下一页
              </Button>
            </div>
          )}
        </>
      )}

      {/* ── 新增向导 ── */}
      <CreateWizard
        open={createOpen}
        onOpenChange={setCreateOpen}
        accounts={accounts}
        onCreated={refreshAll}
      />

      {/* ── 编辑面板 ── */}
      <CardEditDialog
        card={editCard}
        open={Boolean(editCard)}
        onOpenChange={(o) => {
          if (!o) setEditCard(null);
        }}
        accounts={accounts}
        onSaved={refreshAll}
      />

      {/* ── 用量弹窗 ── */}
      <CardUsageDialog
        card={
          usageCard
            ? { id: usageCard.id, key: usageCard.key, name: usageCard.name }
            : null
        }
        open={Boolean(usageCard)}
        onOpenChange={(o) => {
          if (!o) setUsageCard(null);
        }}
      />

      {/* ── 删除二次确认 ── */}
      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(o) => {
          if (!o && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除卡密?</AlertDialogTitle>
            <AlertDialogDescription>
              将永久删除卡密{" "}
              <code className="font-mono">{deleteTarget?.key}</code>
              {deleteTarget?.name ? ` · ${deleteTarget.name}` : ""}
              ,此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? <Spinner data-icon className="size-3.5" /> : null}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── 清理二次确认(过期 / 未绑定共用)── */}
      <AlertDialog
        open={Boolean(cleanupKind)}
        onOpenChange={(o) => {
          if (!o && !cleaning) setCleanupKind(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {cleanupKind === "expired" ? "清理过期卡密?" : "清理未绑定卡密?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {cleanupKind === "expired"
                ? "将批量删除所有已过期的卡密,此操作不可撤销。"
                : "将批量删除所有从未绑定过设备的卡密,此操作不可撤销。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cleaning}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCleanupConfirm}
              disabled={cleaning}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {cleaning ? <Spinner data-icon className="size-3.5" /> : null}
              清理
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
