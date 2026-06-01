import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";

type UsageRecord = {
  id: string;
  accountId: number | null;
  modelKey: string;
  bucket: string;
  status: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  rawTotalTokens: number;
  totalTokens: number;
  timestamp: string;
};

type Totals = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  rawTotalTokens: number;
  totalTokens: number;
};

type ModelRow = {
  modelKey: string;
  bucket: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
};

type DailyRow = { date: string; totalTokens: number; requests: number };

const DAYS_OPTIONS: [number, string][] = [
  [7, "7天"],
  [30, "30天"],
  [90, "90天"],
];

const PAGE_SIZE = 30;

function fmt(n: number | null | undefined): string {
  return Number(n || 0).toLocaleString();
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function CardUsageDialog({
  card,
  open,
  onOpenChange,
}: {
  card: { id: string; key: string; name?: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [days, setDays] = useState(30);
  const [page, setPage] = useState(1);

  const [totals, setTotals] = useState<Totals | null>(null);
  const [byModel, setByModel] = useState<ModelRow[]>([]);
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [totalRecords, setTotalRecords] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);

  const cardId = card?.id || "";

  const fetchData = useCallback(async () => {
    if (!cardId) return;
    setLoading(true);
    try {
      const [summaryRes, recordsRes] = await Promise.all([
        fetch(`/api/rosetta/card-token-usage-summary?cardId=${encodeURIComponent(cardId)}&days=${days}`),
        fetch(
          `/api/rosetta/card-token-usage?cardId=${encodeURIComponent(cardId)}&days=${days}&page=${page}&pageSize=${PAGE_SIZE}`,
        ),
      ]);
      const summary = await summaryRes.json();
      const recs = await recordsRes.json();
      setTotals(summary.totals || null);
      setByModel(summary.byModel || []);
      setDaily(summary.daily || []);
      setRecords(recs.records || []);
      setTotalRecords(recs.total || 0);
      setTotalPages(recs.totalPages || 1);
    } catch {
      setTotals(null);
      setByModel([]);
      setDaily([]);
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, [cardId, days, page]);

  // Reset paging when the card or window changes.
  useEffect(() => {
    setPage(1);
  }, [cardId, days]);

  useEffect(() => {
    if (open && cardId) fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cardId, days, page]);

  const maxDaily = Math.max(1, ...daily.map((d) => d.totalTokens));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Token 使用记录</DialogTitle>
          <DialogDescription>
            <code className="font-mono">{card?.key}</code>
            {card?.name ? ` · ${card.name}` : ""}
          </DialogDescription>
        </DialogHeader>

        {/* Window selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">时间范围:</span>
          {DAYS_OPTIONS.map(([value, label]) => (
            <Button
              key={value}
              variant={days === value ? "default" : "outline"}
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setDays(value)}
            >
              {label}
            </Button>
          ))}
        </div>

        {loading && !totals ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Spinner />
            加载中...
          </div>
        ) : (
          <>
            {/* Totals */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="计费 Token" value={fmt(totals?.totalTokens)} />
              <Stat label="请求数" value={fmt(totals?.requests)} />
              <Stat label="输入 Token" value={fmt(totals?.inputTokens)} />
              <Stat label="输出 Token" value={fmt(totals?.outputTokens)} />
            </div>

            {/* Daily mini bar chart */}
            {daily.some((d) => d.totalTokens > 0) && (
              <div className="rounded-lg border p-3">
                <p className="mb-2 text-xs text-muted-foreground">每日计费 Token</p>
                <div className="flex h-24 items-end gap-[2px]">
                  {daily.map((d) => (
                    <div
                      key={d.date}
                      className="flex-1 rounded-sm bg-primary/70 transition-colors hover:bg-primary"
                      style={{ height: `${Math.max(2, (d.totalTokens / maxDaily) * 100)}%` }}
                      title={`${d.date}: ${fmt(d.totalTokens)} token / ${d.requests} 次`}
                    />
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                  <span>{daily[0]?.date}</span>
                  <span>{daily[daily.length - 1]?.date}</span>
                </div>
              </div>
            )}

            {/* By-model breakdown */}
            {byModel.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium">按模型汇总</p>
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>模型</TableHead>
                        <TableHead>桶</TableHead>
                        <TableHead className="text-right">请求</TableHead>
                        <TableHead className="text-right">输入</TableHead>
                        <TableHead className="text-right">输出</TableHead>
                        <TableHead className="text-right">计费 Token</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byModel.map((m) => (
                        <TableRow key={m.modelKey}>
                          <TableCell className="max-w-[180px] truncate font-mono text-xs">
                            {m.modelKey || "-"}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary" className="text-xs">
                              {m.bucket || "-"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right text-sm">{fmt(m.requests)}</TableCell>
                          <TableCell className="text-right text-sm">{fmt(m.inputTokens)}</TableCell>
                          <TableCell className="text-right text-sm">{fmt(m.outputTokens)}</TableCell>
                          <TableCell className="text-right text-sm font-medium">
                            {fmt(m.totalTokens)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            <Separator />

            {/* Per-call records */}
            <div>
              <p className="mb-2 text-xs font-medium">
                逐次调用流水
                <span className="ml-1 text-muted-foreground">
                  ({totalRecords.toLocaleString()} 条)
                </span>
              </p>
              {records.length === 0 ? (
                <Empty className="py-8">
                  <EmptyHeader>
                    <EmptyTitle>暂无使用记录</EmptyTitle>
                    <EmptyDescription>该卡在所选时间范围内没有 token 使用记录</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <>
                  <div className="overflow-x-auto rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>时间</TableHead>
                          <TableHead>模型</TableHead>
                          <TableHead className="text-right">输入</TableHead>
                          <TableHead className="text-right">输出</TableHead>
                          <TableHead className="text-right">缓存</TableHead>
                          <TableHead className="text-right">计费</TableHead>
                          <TableHead className="text-right">状态</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {records.map((r) => (
                          <TableRow key={r.id}>
                            <TableCell className="whitespace-nowrap text-xs">
                              {formatDateTime(r.timestamp)}
                            </TableCell>
                            <TableCell className="max-w-[160px] truncate font-mono text-xs">
                              {r.modelKey || "-"}
                            </TableCell>
                            <TableCell className="text-right text-sm">{fmt(r.inputTokens)}</TableCell>
                            <TableCell className="text-right text-sm">{fmt(r.outputTokens)}</TableCell>
                            <TableCell className="text-right text-sm text-muted-foreground">
                              {fmt(r.cachedInputTokens)}
                            </TableCell>
                            <TableCell className="text-right text-sm font-medium">
                              {fmt(r.totalTokens)}
                            </TableCell>
                            <TableCell className="text-right text-xs">
                              <span className={r.status >= 200 && r.status < 400 ? "text-muted-foreground" : "text-destructive"}>
                                {r.status}
                              </span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {totalPages > 1 && (
                    <div className="mt-3 flex items-center justify-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page <= 1 || loading}
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                      >
                        上一页
                      </Button>
                      <span className="text-sm text-muted-foreground">
                        {page} / {totalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page >= totalPages || loading}
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      >
                        下一页
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
