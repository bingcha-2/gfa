"use client";

import { useState, useEffect } from "react";

import { useConsole } from "@/components/console/shell/console-provider";
import { apiRequest } from "@/lib/console/client-api";
import { fmtYuan } from "@/lib/console/format";
import type { BillingStats } from "@/lib/console/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Empty } from "@/components/ui/empty";
import {
  CircleCheckIcon,
  TriangleAlertIcon,
  UsersIcon,
  KeyIcon,
  ShoppingCartIcon,
  InboxIcon,
  UserPlusIcon,
  RefreshCwIcon,
  CoinsIcon,
  Undo2Icon,
} from "lucide-react";

function statusVariant(
  status: string
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "COMPLETED":
    case "INVITE_SENT":
      return "secondary";
    case "FAILED":
    case "FAILED_FINAL":
    case "MANUAL_REVIEW":
      return "destructive";
    default:
      return "outline";
  }
}

export default function OverviewPage() {
  const { stats } = useConsole();

  const availableSlots = stats?.availableSlots ?? 0;
  const pendingInvites = stats?.pendingInvites ?? 0;
  const manualReviewTasks = stats?.manualReviewTasks ?? 0;
  const disabledAccounts = stats?.disabledAccounts ?? 0;
  const unusedCodes = stats?.unusedCodes ?? 0;
  const activeOrders = stats?.activeOrders ?? 0;
  const recentOrders = stats?.recentOrders ?? [];
  const reviewQueue = stats?.reviewQueue ?? [];

  const [billing, setBilling] = useState<BillingStats | null>(null);
  useEffect(() => {
    apiRequest<BillingStats>("billing-stats")
      .then(setBilling)
      .catch(() => setBilling(null)); // 无权限（非 ADMIN/OPERATIONS）时静默隐藏
  }, []);

  const customerMetrics = billing
    ? [
        { title: "今日新增客户", value: String(billing.todayNewCustomers), desc: "今日注册的客户数", icon: <UserPlusIcon /> },
        { title: "活跃订阅", value: String(billing.activeSubscriptions), desc: "当前生效中的订阅", icon: <RefreshCwIcon /> },
        { title: "今日收入", value: fmtYuan(billing.todayPaidCents), desc: `${billing.todayPaidCount} 笔已支付`, icon: <CoinsIcon /> },
        { title: "30天退款率", value: `${(billing.refundRate30d * 100).toFixed(1)}%`, desc: "近 30 天退款/成交占比", icon: <Undo2Icon /> },
      ]
    : [];

  const metrics = [
    {
      title: "可用空位",
      value: availableSlots,
      desc: "家庭组剩余可邀请空位",
      icon: <UsersIcon />,
    },
    {
      title: "待接受邀请",
      value: pendingInvites,
      desc: "已发出但未完成的邀请",
      icon: <InboxIcon />,
    },
    {
      title: "待人工处理",
      value: manualReviewTasks,
      desc: "进入人工处理队列的任务",
      icon: <TriangleAlertIcon />,
    },
    {
      title: "异常母号",
      value: disabledAccounts,
      desc: "非正常状态的母号",
      icon: <TriangleAlertIcon />,
    },
    {
      title: "可用卡密",
      value: unusedCodes,
      desc: "未被消耗的卡密库存",
      icon: <KeyIcon />,
    },
    {
      title: "进行中订单",
      value: activeOrders,
      desc: "排队、执行或等待中的订单",
      icon: <ShoppingCartIcon />,
    },
  ];

  return (
    <>
      {/* Metrics Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {metrics.map((m) => (
          <Card key={m.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardDescription>{m.title}</CardDescription>
              <span className="text-muted-foreground">{m.icon}</span>
            </CardHeader>
            <CardContent>
              <CardTitle className="text-2xl tabular-nums">
                {m.value}
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">{m.desc}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 客户业务 KPIs */}
      {billing && (
        <div className="space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground">客户业务</h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {customerMetrics.map((m) => (
              <Card key={m.title}>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardDescription>{m.title}</CardDescription>
                  <span className="text-muted-foreground">{m.icon}</span>
                </CardHeader>
                <CardContent>
                  <CardTitle className="text-2xl tabular-nums">{m.value}</CardTitle>
                  <p className="text-xs text-muted-foreground mt-1">{m.desc}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          {billing.planDistribution.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>套餐分布</CardTitle>
                <CardDescription>按已支付订单数统计</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {billing.planDistribution.map((p) => (
                    <Badge key={p.planId} variant="secondary" className="text-sm">
                      {p.planName} · {p.count}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Recent Orders + Review Queue */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>最近订单</CardTitle>
            <CardDescription>
              优先查看最新提交是否已进入正确状态
            </CardDescription>
          </CardHeader>
          <CardContent>
            {recentOrders.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>订单号</TableHead>
                    <TableHead>邮箱</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentOrders.map((order: any) => (
                    <TableRow key={order.id}>
                      <TableCell className="font-mono text-xs">
                        {order.orderNo}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {order.userEmail}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(order.status)}>
                          {order.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Empty>
                <CircleCheckIcon className="text-muted-foreground" />
                <p>还没有订单</p>
              </Empty>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>人工接管队列</CardTitle>
            <CardDescription>
              需要人工处理的任务，优先处理最紧急的
            </CardDescription>
          </CardHeader>
          <CardContent>
            {reviewQueue.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>标识</TableHead>
                    <TableHead>信息</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reviewQueue.map((task: any) => (
                    <TableRow key={task.id}>
                      <TableCell className="font-mono text-xs">
                        {task.order?.orderNo ?? task.id.slice(0, 12)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {task.familyGroup?.groupName ?? "-"} · {task.type}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(task.status)}>
                          {task.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Empty>
                <CircleCheckIcon className="text-muted-foreground" />
                <p>当前没有待人工任务</p>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
