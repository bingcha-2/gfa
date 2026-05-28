"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  SearchIcon,
  XIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CoinsIcon,
  TrendingDownIcon,
  ActivityIcon,
} from "lucide-react";

type ConsumptionRecord = {
  id: string;
  accountId: number;
  email: string;
  oldAmount: number;
  newAmount: number;
  consumed: number;
  accessKeyId: string | null;
  accessKeyName: string | null;
  timestamp: string;
};

type ConsumptionResponse = {
  records: ConsumptionRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatNumber(n: number): string {
  return Math.round(n).toLocaleString();
}

export default function RosettaCreditsPage() {
  const [data, setData] = useState<ConsumptionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [days, setDays] = useState("7");
  const [pageSize] = useState(30);

  // Summary stats
  const [stats, setStats] = useState<{
    todayConsumed: number;
    todayEvents: number;
    totalCredits: number;
    accountsWithCredits: number;
  } | null>(null);

  const fetchData = useCallback(
    async (p?: number, s?: string) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          page: String(p ?? page),
          pageSize: String(pageSize),
          days,
        });
        const term = (s ?? search).trim();
        if (term) params.set("search", term);

        const [recordsRes, statsRes] = await Promise.all([
          fetch(`/api/rosetta/credit-consumption?${params}`),
          fetch(`/api/rosetta/credit-stats?days=${days}`),
        ]);
        const recordsData = await recordsRes.json();
        const statsData = await statsRes.json();

        setData(recordsData);
        if (statsData.current) {
          setStats({
            todayConsumed: statsData.today?.consumed || 0,
            todayEvents: statsData.today?.events || 0,
            totalCredits: statsData.current.totalCredits || 0,
            accountsWithCredits: statsData.current.accountsWithCredits || 0,
          });
        }
      } catch {
        toast.error("加载消耗记录失败");
      } finally {
        setLoading(false);
      }
    },
    [page, pageSize, days, search],
  );

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = () => {
    setPage(1);
    fetchData(1);
  };

  const handleClear = () => {
    setSearch("");
    setPage(1);
    fetchData(1, "");
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    fetchData(newPage);
  };

  const handleDaysChange = (value: string) => {
    setDays(value);
    setPage(1);
    // Need to fetch with new days value
    setTimeout(() => fetchData(1), 0);
  };

  // Group by accessKeyId for summary
  const keyStats = useMemo(() => {
    if (!data?.records) return [];
    const map = new Map<
      string,
      { keyId: string; keyName: string; total: number; count: number }
    >();
    for (const r of data.records) {
      const kid = r.accessKeyId || "(未关联)";
      const existing = map.get(kid);
      if (existing) {
        existing.total += r.consumed;
        existing.count++;
      } else {
        map.set(kid, {
          keyId: kid,
          keyName: r.accessKeyName || "",
          total: r.consumed,
          count: 1,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [data]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">积分消耗记录</h1>
        <p className="text-sm text-muted-foreground">
          查看 AI 积分消耗明细，关联触发消耗的卡密信息。
        </p>
      </div>

      {/* Summary Cards */}
      {stats && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <TrendingDownIcon className="size-4" />
                今日消耗
              </div>
              <p className="mt-1 text-2xl font-bold text-orange-500">
                {formatNumber(stats.todayConsumed)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <ActivityIcon className="size-4" />
                今日事件数
              </div>
              <p className="mt-1 text-2xl font-bold">
                {stats.todayEvents.toLocaleString()}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CoinsIcon className="size-4" />
                总积分余额
              </div>
              <p className="mt-1 text-2xl font-bold">
                {formatNumber(stats.totalCredits)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                有积分账号
              </div>
              <p className="mt-1 text-2xl font-bold">
                {stats.accountsWithCredits}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Records Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">消耗明细</CardTitle>
          <div className="flex items-center gap-2">
            <Select value={days} onValueChange={handleDaysChange}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">今天</SelectItem>
                <SelectItem value="3">近 3 天</SelectItem>
                <SelectItem value="7">近 7 天</SelectItem>
                <SelectItem value="30">近 30 天</SelectItem>
              </SelectContent>
            </Select>
            <Input
              className="w-56"
              placeholder="搜索邮箱 / 卡密名称"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSearch();
                }
              }}
            />
            <Button variant="outline" size="sm" onClick={handleSearch}>
              <SearchIcon data-icon className="size-4" />
              搜索
            </Button>
            <Button variant="ghost" size="sm" onClick={handleClear}>
              <XIcon data-icon className="size-4" />
              清空
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Spinner />
              加载中...
            </div>
          ) : !data?.records?.length ? (
            <Empty className="py-12">
              <EmptyHeader>
                <EmptyTitle>
                  {search ? "没有匹配的消耗记录" : "暂无消耗记录"}
                </EmptyTitle>
                <EmptyDescription>
                  {search
                    ? "尝试修改搜索条件"
                    : "当有积分消耗时记录会自动出现"}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <p className="mb-3 text-xs text-muted-foreground">
                共 {data.total.toLocaleString()} 条记录，第 {data.page}/
                {data.totalPages} 页
              </p>

              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>账号</TableHead>
                      <TableHead className="text-right">消耗</TableHead>
                      <TableHead className="text-right">
                        余额变化
                      </TableHead>
                      <TableHead>关联卡密</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.records.map((record) => (
                      <TableRow key={record.id}>
                        <TableCell className="whitespace-nowrap text-sm">
                          {formatDateTime(record.timestamp)}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="text-sm truncate max-w-[200px]">
                              {record.email}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              #{record.accountId}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge
                            variant={
                              record.consumed >= 100
                                ? "destructive"
                                : record.consumed >= 30
                                  ? "secondary"
                                  : "outline"
                            }
                          >
                            -{formatNumber(record.consumed)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right text-sm whitespace-nowrap text-muted-foreground">
                          {formatNumber(record.oldAmount)} →{" "}
                          {formatNumber(record.newAmount)}
                        </TableCell>
                        <TableCell>
                          {record.accessKeyId ? (
                            <div className="flex flex-col">
                              <span className="text-sm">
                                {record.accessKeyName || "-"}
                              </span>
                              <code className="text-xs text-muted-foreground font-mono truncate max-w-[120px]">
                                {record.accessKeyId.slice(0, 12)}...
                              </code>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              -
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {data.totalPages > 1 && (
                <div className="mt-4 flex items-center justify-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={data.page <= 1}
                    onClick={() => handlePageChange(data.page - 1)}
                  >
                    <ChevronLeftIcon className="size-4" />
                    上一页
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {data.page} / {data.totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={data.page >= data.totalPages}
                    onClick={() => handlePageChange(data.page + 1)}
                  >
                    下一页
                    <ChevronRightIcon className="size-4" />
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Per-key breakdown (current page) */}
      {keyStats.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              当前页卡密消耗分布
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>卡密</TableHead>
                    <TableHead className="text-right">消耗积分</TableHead>
                    <TableHead className="text-right">事件数</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keyStats.map((ks) => (
                    <TableRow key={ks.keyId}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm">
                            {ks.keyName || ks.keyId}
                          </span>
                          {ks.keyName && (
                            <code className="text-xs text-muted-foreground font-mono">
                              {ks.keyId.slice(0, 16)}
                            </code>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatNumber(ks.total)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {ks.count}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
