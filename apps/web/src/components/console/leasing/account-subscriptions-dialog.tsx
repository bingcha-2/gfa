"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { consoleApiPath } from "@/lib/console/client-api";
import { formatDateTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

// 对齐 server RosettaService.ClaudeAccountSubscription。
type AccountSubscription = {
  id: string;
  customerId: string;
  customerEmail: string;
  customerName: string;
  status: string;
  exclusive: boolean;
  weight: number;
  startsAt: string | null;
  expiresAt: string | null;
  order: {
    id: string;
    outTradeNo: string;
    amountCents: number;
    payChannel: string;
    status: string;
    paidAt: string | null;
  } | null;
};

export type AccountSubscriptionsTarget = { id: number; email: string };

function money(cents: number): string {
  return `¥${(Number(cents || 0) / 100).toFixed(2)}`;
}

/**
 * 点某个母号 email 弹出的关联订单/账户对话框:列出该号当前被哪些 ACTIVE 订阅绑定
 * (客户 email / 份额 / 到期 / 下单订单)。数据源 GET anthropic-account-subscriptions,
 * 与列表「份额用量」同口径(只数 line=bind、bindings.anthropic 命中)。
 */
export function AccountSubscriptionsDialog({
  target,
  onOpenChange,
}: {
  target: AccountSubscriptionsTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [subs, setSubs] = useState<AccountSubscription[]>([]);
  const accountId = target?.id ?? 0;

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setLoading(true);
    setSubs([]);
    (async () => {
      try {
        const res = await fetch(
          consoleApiPath(`rosetta/anthropic-account-subscriptions?accountId=${accountId}`),
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setSubs(Array.isArray(data.subscriptions) ? data.subscriptions : []);
      } catch (error) {
        if (!cancelled) toast.error(`关联订阅获取失败: ${error instanceof Error ? error.message : "未知错误"}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>关联订阅 · #{target?.id}</DialogTitle>
          <DialogDescription>
            {target?.email}
            {" · "}
            当前绑定该母号的 ACTIVE 订阅(与「份额用量」同口径)
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex min-h-[160px] items-center justify-center">
            <Spinner size={20} />
          </div>
        ) : !subs.length ? (
          <div className="py-10 text-center text-sm text-muted-foreground">该母号暂无 ACTIVE 订阅绑定</div>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>客户</TableHead>
                  <TableHead>份额</TableHead>
                  <TableHead>到期</TableHead>
                  <TableHead>订单号</TableHead>
                  <TableHead>金额</TableHead>
                  <TableHead>支付</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {subs.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="font-medium">{s.customerEmail || "—"}</div>
                      {s.customerName ? (
                        <div className="text-xs text-muted-foreground">{s.customerName}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">
                      <Badge variant={s.exclusive ? "default" : "secondary"}>
                        {s.exclusive ? "独享" : "拼车"} · {s.weight} 份
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {s.expiresAt ? formatDateTime(s.expiresAt) : "长期"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{s.order?.outTradeNo || "—"}</TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {s.order ? money(s.order.amountCents) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {s.order ? [s.order.payChannel, s.order.status].filter(Boolean).join(" · ") : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
