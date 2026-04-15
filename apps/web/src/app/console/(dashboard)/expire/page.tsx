"use client";

import { useState, useEffect, useTransition } from "react";
import { apiRequest, getErrorMessage } from "@/lib/client-api";
import type { OrderSummary } from "@/lib/types";
import { formatDateTime } from "@/lib/format";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock, Zap, Loader2, AlertTriangle, Timer } from "lucide-react";

type ScanStatus = { pendingCount: number; lastRunAt: string | null; lastRunCount: number };
type ProcessedOrder = { orderId: string; orderNo: string; userEmail: string; familyGroupId: string | null };
type RunResult = { triggered: boolean; processedCount: number; orders: ProcessedOrder[] };

function fmtDate(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "medium" }) : "—";
}

export default function ExpirePage() {
  const [expiredOrders, setExpiredOrders] = useState<OrderSummary[]>([]);
  const [isLoadingOrders, setIsLoadingOrders] = useState(true);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isScanning, startTransition] = useTransition();

  async function loadExpiredOrders() {
    setIsLoadingOrders(true);
    try {
      const res = await apiRequest<{ items: OrderSummary[]; total: number }>("orders?status=EXPIRED&pageSize=100");
      setExpiredOrders(res.items);
    } catch { /* ignore */ }
    finally { setIsLoadingOrders(false); }
  }

  async function loadStatus() {
    try {
      const data = await apiRequest<ScanStatus>("admin/expire-scan/status");
      setStatus(data);
      setError(null);
    } catch (err) { setError(getErrorMessage(err)); }
  }

  useEffect(() => { loadExpiredOrders(); }, []);

  function triggerScan() {
    startTransition(async () => {
      try {
        const result = await apiRequest<RunResult>("admin/expire-scan/run", { method: "POST" });
        setRunResult(result);
        toast.success(`扫描完成，处理了 ${result.processedCount} 条`);
        const s = await apiRequest<ScanStatus>("admin/expire-scan/status");
        setStatus(s);
        setError(null);
        await loadExpiredOrders();
      } catch (err) { setError(getErrorMessage(err)); }
    });
  }

  return (
    <div className="space-y-6">
      {error && <Card className="border-destructive"><CardContent className="pt-6 text-destructive text-sm">{error}</CardContent></Card>}

      {/* Top cards */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Cron config */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Timer className="h-5 w-5" />自动扫描配置</CardTitle>
            <CardDescription>每小时整点自动扫描到期订单并推送移除任务</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between py-2 border-b text-sm">
              <span className="text-muted-foreground">执行频率</span><span className="font-mono font-medium">每小时</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b text-sm">
              <span className="text-muted-foreground">有效期规则</span><span className="font-mono font-medium">assignedAt + 30 天</span>
            </div>
            <div className="flex items-center justify-between py-2 text-sm">
              <span className="text-muted-foreground">幂等保障</span><span className="font-mono text-xs">jobId = expire-{"{orderId}"}</span>
            </div>
          </CardContent>
        </Card>

        {/* Scan status + trigger */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Zap className="h-5 w-5" />扫描状态</CardTitle>
            <CardDescription>查看待到期订单和上次运行记录</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void loadStatus()}>查询状态</Button>
              <Button onClick={triggerScan} disabled={isScanning}>
                {isScanning ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Zap className="h-4 w-4 mr-2" />}
                {isScanning ? "扫描中..." : "立即扫描"}
              </Button>
            </div>
            {status && (
              <>
                <div className="flex items-center justify-between py-2 border-b text-sm">
                  <span className="text-muted-foreground">待到期订单</span><span className="font-bold text-lg">{status.pendingCount}</span>
                </div>
                <div className="flex items-center justify-between py-2 border-b text-sm">
                  <span className="text-muted-foreground">上次运行</span><span className="font-mono text-sm">{fmtDate(status.lastRunAt)}</span>
                </div>
                <div className="flex items-center justify-between py-2 text-sm">
                  <span className="text-muted-foreground">上次处理</span><span className="font-bold">{status.lastRunCount} 条</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Run result */}
      {runResult && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">本次扫描结果</CardTitle>
            <CardDescription>共处理 {runResult.processedCount} 条到期订单</CardDescription>
          </CardHeader>
          <CardContent>
            {runResult.orders.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>订单号</TableHead>
                      <TableHead>用户邮箱</TableHead>
                      <TableHead className="w-20">状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runResult.orders.map((o) => (
                      <TableRow key={o.orderId}>
                        <TableCell className="font-mono text-sm">{o.orderNo}</TableCell>
                        <TableCell className="text-sm">{o.userEmail}</TableCell>
                        <TableCell><Badge variant="destructive" className="text-xs">EXPIRED</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-center text-muted-foreground py-4">没有需要处理的到期订单</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Historical expired orders */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-amber-500" />历史到期记录</CardTitle>
          <CardDescription>所有已被标记为 EXPIRED 的订单</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoadingOrders ? (
            <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : expiredOrders.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>订单号</TableHead>
                    <TableHead>用户邮箱</TableHead>
                    <TableHead>更新时间</TableHead>
                    <TableHead className="w-20">状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {expiredOrders.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-mono text-sm">{o.orderNo}</TableCell>
                      <TableCell className="text-sm">{o.userEmail}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{fmtDate(o.updatedAt)}</TableCell>
                      <TableCell><Badge variant="destructive" className="text-xs">EXPIRED</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-center text-muted-foreground py-8">还没有到期记录</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
