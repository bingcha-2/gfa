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
} from "lucide-react";

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
  durationMs?: number;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  sessionClientId: string;
  sessionExpiresAt: string;
  anomalyCount?: number;
};

const PAGE_SIZE = 20;

type SortField =
  | "totalTokensUsed"
  | "recentWindowTokens"
  | "totalRequests"
  | "anomalyCount"
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

  const [sortField, setSortField] = useState<SortField>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  // Create form state
  const [createName, setCreateName] = useState("");
  const [createDurationValue, setCreateDurationValue] = useState("1");
  const [createDurationUnit, setCreateDurationUnit] = useState("d");
  const [createLimit, setCreateLimit] = useState("");
  const [createTokenLimit, setCreateTokenLimit] = useState("");
  const [createCount, setCreateCount] = useState("1");
  const [creating, setCreating] = useState(false);

  // Key reveal dialog
  const [revealKeys, setRevealKeys] = useState<string[]>([]);
  const [revealOpen, setRevealOpen] = useState(false);

  // Delete dialog
  const [deleteTarget, setDeleteTarget] = useState<AccessKey | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
      const count = Math.max(1, Math.min(200, Number(createCount) || 1));

      const payload: Record<string, unknown> = {
        name: createName.trim() || undefined,
        durationMs,
        count,
      };
      if (createLimit.trim()) {
        payload.windowLimit = Number(createLimit);
      }
      if (createTokenLimit.trim()) {
        payload.tokenWindowLimit = Number(createTokenLimit);
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
                ["recentWindowTokens", "5h Token"],
                ["totalTokensUsed", "总Token"],
                ["totalRequests", "请求数"],
                ["anomalyCount", "异常"],
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
                      <TableHead>有效期</TableHead>
                      <TableHead
                        className="cursor-pointer select-none"
                        onClick={() => toggleSort("recentWindowTokens")}
                      >
                        <div className="flex items-center gap-1">
                          5h Token窗口
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
                        <TableCell className="text-sm whitespace-nowrap">
                          {formatDuration(item.durationMs)}
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">
                          {item.recentWindowTokens.toLocaleString()} /{" "}
                          {item.tokenWindowLimit > 0
                            ? item.tokenWindowLimit.toLocaleString()
                            : "∞"}
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
