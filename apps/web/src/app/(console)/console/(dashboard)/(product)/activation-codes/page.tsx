"use client";

// 激活码管理(console / activation-codes)—— 选套餐(绑定线 selection)+ 数量批量生成激活码;
// 列表查看状态/激活时间/激活客户/批次,可停用未激活的码、导出整批为 txt。
// 生成不碰账号池(不占座位);座位在用户激活那一刻才分配。后端见 ActivationCodeService。

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import {
  computePurchase,
  type CatalogConfig,
  type Selection,
} from "@/lib/account/catalog-pricing";
import { fmtYuan } from "@/lib/console/format";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Empty } from "@/components/ui/empty";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const SEAT_OPTIONS = [1, 2, 4, 8] as const;

type CodeStatus = "UNUSED" | "ACTIVATED" | "DISABLED";

type CodeRow = {
  id: string;
  code: string;
  status: CodeStatus;
  name: string | null;
  batchId: string | null;
  activatedAt: string | null;
  activatedByEmail: string | null;
  subscriptionId: string | null;
  createdAt: string;
};

const STATUS_BADGE: Record<CodeStatus, { label: string; variant: "default" | "secondary" | "outline" }> = {
  UNUSED: { label: "未激活", variant: "secondary" },
  ACTIVATED: { label: "已激活", variant: "default" },
  DISABLED: { label: "已停用", variant: "outline" },
};

export default function ActivationCodesPage() {
  const [catalog, setCatalog] = useState<CatalogConfig | null>(null);
  const [catalogErr, setCatalogErr] = useState<string | null>(null);

  // ── 生成表单(绑定线;与「新建订阅」同结构)──
  const [bindLevels, setBindLevels] = useState<Record<string, string>>({});
  const [shareSeats, setShareSeats] = useState<number>(1);
  const [deviceLimit, setDeviceLimit] = useState<number>(1);
  const [count, setCount] = useState<number>(1);
  const [name, setName] = useState<string>("");
  const [generating, setGenerating] = useState(false);
  const [lastGenerated, setLastGenerated] = useState<{ codes: string[]; batchId: string } | null>(null);

  // ── 列表 ──
  const [rows, setRows] = useState<CodeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<"ALL" | CodeStatus>("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 20;

  useEffect(() => {
    fetch("/api/plan-catalog", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { config: CatalogConfig | null }) => {
        if (d.config) setCatalog(d.config);
        else setCatalogErr("套餐目录未发布,无法生成激活码。请先在「套餐配置」发布一个版本。");
      })
      .catch((e) => setCatalogErr(getErrorMessage(e)));
  }, []);

  const products = useMemo(() => catalog?.products ?? [], [catalog]);
  const levelsFor = useCallback((p: string) => catalog?.levels?.[p] ?? [], [catalog]);
  const shareCapacity = catalog?.shareCapacity ?? 8;
  const seatOptions = useMemo(() => SEAT_OPTIONS.filter((n) => n <= shareCapacity), [shareCapacity]);

  const selection: Selection | null = useMemo(() => {
    const items = Object.entries(bindLevels)
      .filter(([, level]) => !!level)
      .map(([product, level]) => ({ product, level }));
    if (items.length === 0) return null;
    return { line: "bind", items, shareSeats, deviceLimit };
  }, [bindLevels, shareSeats, deviceLimit]);

  const priceCents = useMemo(() => {
    if (!catalog || !selection) return null;
    try {
      return computePurchase(catalog, selection).priceCents;
    } catch {
      return null;
    }
  }, [catalog, selection]);

  const loadList = useCallback(async () => {
    try {
      const res = await apiRequest<{ items: CodeRow[]; total: number }>("activation-codes", {
        search: {
          status: statusFilter === "ALL" ? undefined : statusFilter,
          search: search.trim() || undefined,
          page,
          pageSize,
        },
      });
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  }, [statusFilter, search, page]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  function toggleProduct(product: string) {
    setBindLevels((prev) => {
      if (product in prev) {
        const next = { ...prev };
        delete next[product];
        return next;
      }
      const firstLevel = levelsFor(product)[0];
      if (!firstLevel) return prev;
      return { ...prev, [product]: firstLevel };
    });
  }

  async function handleGenerate() {
    if (!selection || generating) return;
    setGenerating(true);
    setLastGenerated(null);
    try {
      const res = await apiRequest<{ count: number; batchId: string; codes: string[] }>("activation-codes", {
        method: "POST",
        body: { selection, count, name: name.trim() || undefined },
      });
      setLastGenerated({ codes: res.codes, batchId: res.batchId });
      toast.success(`已生成 ${res.count} 个激活码`);
      setPage(1);
      await loadList();
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setGenerating(false);
    }
  }

  async function handleDisable(id: string) {
    try {
      await apiRequest(`activation-codes/${id}/disable`, { method: "POST" });
      toast.success("已停用");
      await loadList();
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  }

  function download(codes: string[], filename: string) {
    const blob = new Blob([codes.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleExport() {
    try {
      const res = await apiRequest<{ codes: string[] }>("activation-codes/export", {
        search: {
          status: statusFilter === "ALL" ? undefined : statusFilter,
          search: search.trim() || undefined,
        },
      });
      if (res.codes.length === 0) {
        toast.info("当前筛选无可导出的激活码");
        return;
      }
      download(res.codes, `activation-codes-${Date.now()}.txt`);
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold">激活码管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          选套餐 + 数量批量生成激活码。生成时不绑定账号、不占座位;用户在账户后台兑换时才开通订阅并分配账号。
        </p>
      </div>

      {/* ── 生成 ── */}
      <Card>
        <CardHeader>
          <CardTitle>生成激活码</CardTitle>
          <CardDescription>选择产品与会员等级、份额,批量生成。激活时按当前套餐目录计价开通订阅。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {catalogErr && <p className="text-sm text-destructive">{catalogErr}</p>}
          {!catalog && !catalogErr && <p className="text-sm text-muted-foreground">加载套餐目录…</p>}

          {catalog && (
            <>
              <div className="flex flex-col gap-2">
                <Label>产品 + 会员等级</Label>
                {products.length === 0 && <p className="text-sm text-muted-foreground">当前目录无可售产品。</p>}
                <div className="flex flex-col gap-2">
                  {products.map((product) => {
                    const checked = product in bindLevels;
                    const levels = levelsFor(product);
                    const cbId = `ac-product-${product}`;
                    return (
                      <div key={product} className="flex items-center gap-3">
                        <Checkbox id={cbId} checked={checked} onCheckedChange={() => toggleProduct(product)} />
                        <Label htmlFor={cbId} className="w-32 cursor-pointer capitalize">{product}</Label>
                        {checked && (
                          <Select value={bindLevels[product]} onValueChange={(v) => setBindLevels((p) => ({ ...p, [product]: v }))}>
                            <SelectTrigger className="w-44">
                              <SelectValue placeholder="选择等级" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {levels.map((lvl) => (
                                  <SelectItem key={lvl} value={lvl}>{lvl}</SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-wrap gap-6">
                <div className="flex flex-col gap-2">
                  <Label>份额(1=拼车 … {shareCapacity}=独享)</Label>
                  <Select value={String(shareSeats)} onValueChange={(v) => setShareSeats(Number(v))}>
                    <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {seatOptions.map((n) => (
                          <SelectItem key={n} value={String(n)}>{n} 份</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ac-devices">设备数</Label>
                  <Input
                    id="ac-devices"
                    type="number"
                    min={1}
                    max={20}
                    className="w-24"
                    value={deviceLimit}
                    onChange={(e) => setDeviceLimit(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ac-count">数量(1–200)</Label>
                  <Input
                    id="ac-count"
                    type="number"
                    min={1}
                    max={200}
                    className="w-24"
                    value={count}
                    onChange={(e) => setCount(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
                  />
                </div>
                <div className="flex flex-1 flex-col gap-2">
                  <Label htmlFor="ac-name">备注(可选)</Label>
                  <Input id="ac-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="如:618 活动" />
                </div>
              </div>

              <div className="flex items-center gap-4">
                <Button onClick={handleGenerate} disabled={!selection || generating}>
                  {generating ? "生成中…" : `生成 ${count} 个`}
                </Button>
                {priceCents != null && (
                  <span className="text-sm text-muted-foreground">单个等值价格:{fmtYuan(priceCents)}</span>
                )}
              </div>

              {lastGenerated && (
                <div className="flex flex-col gap-2 rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      已生成 {lastGenerated.codes.length} 个 · 批次 <code className="text-xs">{lastGenerated.batchId}</code>
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => download(lastGenerated.codes, `activation-codes-${lastGenerated.batchId}.txt`)}
                    >
                      下载 .txt
                    </Button>
                  </div>
                  <Textarea
                    readOnly
                    className="font-mono text-xs"
                    rows={Math.min(8, Math.max(2, lastGenerated.codes.length))}
                    value={lastGenerated.codes.join("\n")}
                  />
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ── 列表 ── */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>激活码列表</CardTitle>
            <CardDescription>共 {total} 个</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v as any); setPage(1); }}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="ALL">全部状态</SelectItem>
                  <SelectItem value="UNUSED">未激活</SelectItem>
                  <SelectItem value="ACTIVATED">已激活</SelectItem>
                  <SelectItem value="DISABLED">已停用</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Input
              className="w-48"
              placeholder="搜索激活码"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
            <Button variant="outline" onClick={handleExport}>导出当前筛选</Button>
          </div>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <Empty>暂无激活码</Empty>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>激活码</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>激活客户</TableHead>
                    <TableHead>激活时间</TableHead>
                    <TableHead>批次</TableHead>
                    <TableHead>备注</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const badge = STATUS_BADGE[r.status];
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono text-xs">{r.code}</TableCell>
                        <TableCell><Badge variant={badge.variant}>{badge.label}</Badge></TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.activatedByEmail ?? "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {r.activatedAt ? new Date(r.activatedAt).toLocaleString() : "—"}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{r.batchId ?? "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.name ?? "—"}</TableCell>
                        <TableCell className="text-right">
                          {r.status === "UNUSED" ? (
                            <Button size="sm" variant="ghost" onClick={() => handleDisable(r.id)}>停用</Button>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              <div className="mt-4 flex items-center justify-end gap-3 text-sm">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
                <span className="text-muted-foreground">{page} / {totalPages}</span>
                <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
