"use client";

// 精简卡密表格 —— 重设计后的 5 列布局,取代旧 page.tsx 里 12 列横向滚动的大表。
// 列:① 卡密/备注(code + 复制 + 备注副行)② 类型(徽章:万能蓝 / 绑定·<产品>紫 + 账号副行)
//     ③ 状态·到期(status 徽章 + 剩余天数;<7d 黄,过期红)④ 额度(<QuotaCell>)⑤ 操作。
// 行展开(点行首 ▸):收纳次要信息——异常计数 / 客户端ID / 最后使用 / 逐模型用量明细。
// 完全受控:数据来自 keys(AccessKeyListItem[]);所有行为(编辑/用量/启停/删除/复制/展开)
// 经 props 回调上抛,本组件不持有除「展开行集合」外的任何业务状态。

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  ChevronRightIcon,
  CopyIcon,
  PencilIcon,
  BarChart3Icon,
  PauseIcon,
  PlayIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { QuotaCell } from "./quota-cell";
import type { AccessKeyListItem } from "./types";
import { formatTokens } from "@/lib/format";

// ── 产品标签(类型徽章副标题 / 绑定明细用)──
const PRODUCT_LABELS: Record<string, string> = {
  antigravity: "Antigravity",
  codex: "Codex",
  anthropic: "Anthropic",
};

/** 时长缩写:小时/天(对齐 page.tsx 的 formatDuration 语义)。 */
function formatDuration(ms: number | undefined | null): string {
  if (!ms || ms <= 0) return "永久";
  const hours = ms / 3600000;
  if (hours < 24) return `${Math.round(hours)}小时`;
  return `${Math.round(hours / 24)}天`;
}

/** 本地时间(zh-CN / Asia/Shanghai;对齐 page.tsx 的 formatDateTime)。 */
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

/** 卡密状态徽章颜色(对齐 page.tsx 的 statusVariant)。 */
function statusVariant(
  status: string,
): "default" | "secondary" | "destructive" {
  switch (status) {
    case "active":
      return "default";
    case "disabled":
      return "secondary";
    case "revoked":
    case "expired":
      return "destructive";
    default:
      return "secondary";
  }
}

/** 剩余到期信息:返回展示文案 + 紧迫度(过期红 / <7d 黄 / 其余灰)。 */
// 到期文案。有效期「从首次使用起算」:
//   - durationMs=0 → 真·永不过期;
//   - 有有效期但还没首次使用(expiresAt 为空)→ 显示「N天 · 未启用」(尚未开始计时);
//   - 已启动 → 剩余 / 已过期。
function expiryInfo(
  expiresAt: string,
  durationMs: number,
): { text: string; tone: "expired" | "soon" | "normal" } {
  if (!Number(durationMs)) return { text: "永不过期", tone: "normal" };
  if (!expiresAt) {
    return { text: `${formatDuration(durationMs)} · 未启用`, tone: "normal" };
  }
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) return { text: "已过期", tone: "expired" };
  const remainHours = remaining / 3600000;
  if (remainHours < 24) {
    return { text: `剩余 ${Math.ceil(remainHours)}h`, tone: "soon" };
  }
  const remainDays = Math.ceil(remainHours / 24);
  return {
    text: `剩余 ${remainDays}d`,
    tone: remainDays < 7 ? "soon" : "normal",
  };
}

export interface KeyTableProps {
  /** 列表数据(已过滤/排序/分页后的当前页)。 */
  keys: AccessKeyListItem[];
  /** 是否搜索/筛选状态下无匹配(空态文案区分「无卡」/「无匹配」)。 */
  hasActiveFilter?: boolean;
  /** 复制完整卡密。 */
  onCopy: (fullKey: string) => void;
  /** 打开编辑面板。 */
  onEdit: (key: AccessKeyListItem) => void;
  /** 打开用量弹窗。 */
  onUsage: (key: AccessKeyListItem) => void;
  /** 启用/禁用切换(直接切,父做乐观更新)。 */
  onToggle: (key: AccessKeyListItem) => void;
  /** 删除(父弹 AlertDialog 二次确认)。 */
  onDelete: (key: AccessKeyListItem) => void;
}

export function KeyTable({
  keys,
  hasActiveFilter,
  onCopy,
  onEdit,
  onUsage,
  onToggle,
  onDelete,
}: KeyTableProps) {
  // 展开的行 id 集合(本组件唯一持有的本地 UI 状态)。
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 空态:区分「完全无卡」与「筛选无匹配」。
  if (keys.length === 0) {
    return (
      <Empty className="py-12">
        <EmptyHeader>
          <EmptyTitle>
            {hasActiveFilter ? "没有匹配的卡密" : "暂无卡密"}
          </EmptyTitle>
          <EmptyDescription>
            {hasActiveFilter
              ? "试试调整搜索关键词或筛选条件。"
              : "点击右上角「生成卡密」创建第一张卡。"}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            {/* 展开箭头占位列(无标题) */}
            <TableHead className="w-8" />
            <TableHead>卡密 / 备注</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>状态 · 到期</TableHead>
            <TableHead className="min-w-[180px]">额度</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((item) => {
            const isOpen = expanded.has(item.id);
            const isPool = item.cardType === "pool";
            const exp = expiryInfo(item.expiresAt, item.durationMs);
            const anomaly = Number(item.anomalyCount || 0);
            // 绑定卡份额容量:由后端 listAccessKeys 下发(全局常量 ACCOUNT_SHARE_CAPACITY),不再硬编码。
            const shareCapacity = Number(item.shareCapacity) || 8;

            return (
              <RowFragment
                key={item.id}
                item={item}
                isOpen={isOpen}
                isPool={isPool}
                exp={exp}
                anomaly={anomaly}
                shareCapacity={shareCapacity}
                onToggleExpand={() => toggleExpand(item.id)}
                onCopy={onCopy}
                onEdit={onEdit}
                onUsage={onUsage}
                onToggle={onToggle}
                onDelete={onDelete}
              />
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ── 单行 + 行展开(拆成子组件,避免在 map 内堆叠过深的 JSX)──
function RowFragment({
  item,
  isOpen,
  isPool,
  exp,
  anomaly,
  shareCapacity,
  onToggleExpand,
  onCopy,
  onEdit,
  onUsage,
  onToggle,
  onDelete,
}: {
  item: AccessKeyListItem;
  isOpen: boolean;
  isPool: boolean;
  exp: { text: string; tone: "expired" | "soon" | "normal" } | null;
  anomaly: number;
  shareCapacity: number;
  onToggleExpand: () => void;
  onCopy: (fullKey: string) => void;
  onEdit: (key: AccessKeyListItem) => void;
  onUsage: (key: AccessKeyListItem) => void;
  onToggle: (key: AccessKeyListItem) => void;
  onDelete: (key: AccessKeyListItem) => void;
}) {
  // 到期文案颜色。
  const expColor =
    exp?.tone === "expired"
      ? "text-destructive"
      : exp?.tone === "soon"
        ? "text-yellow-600 dark:text-yellow-500"
        : "text-muted-foreground";

  return (
    <>
      <TableRow>
        {/* 展开箭头 */}
        <TableCell className="w-8 align-top">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={isOpen ? "收起明细" : "展开明细"}
            onClick={onToggleExpand}
          >
            <ChevronRightIcon
              data-icon
              className={`size-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`}
            />
          </Button>
        </TableCell>

        {/* ① 卡密 / 备注 */}
        <TableCell className="align-top">
          <div className="flex items-center gap-1">
            <code className="font-mono text-xs">{item.key}</code>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      onClick={() => onCopy(item.fullKey || item.key)}
                    />
                  }
                >
                  <CopyIcon data-icon className="size-3" />
                </TooltipTrigger>
                <TooltipContent>复制卡密</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          {item.name && (
            <div className="mt-0.5 max-w-[160px] truncate text-xs text-muted-foreground">
              {item.name}
            </div>
          )}
        </TableCell>

        {/* ② 类型 */}
        <TableCell className="align-top">
          {isPool ? (
            <Badge className="bg-blue-500/15 text-blue-600 hover:bg-blue-500/15 dark:text-blue-400">
              万能
            </Badge>
          ) : (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap gap-1">
                {item.bindingsDetail.length > 0 ? (
                  item.bindingsDetail.map((b) => (
                    <Badge
                      key={b.product}
                      className="bg-purple-500/15 text-purple-600 hover:bg-purple-500/15 dark:text-purple-400"
                    >
                      绑定 · {PRODUCT_LABELS[b.product] || b.product}
                    </Badge>
                  ))
                ) : (
                  <Badge className="bg-purple-500/15 text-purple-600 hover:bg-purple-500/15 dark:text-purple-400">
                    绑定
                  </Badge>
                )}
              </div>
              {/* 绑定账号只读副行(email 优先,缺省用 id) */}
              {item.bindingsDetail.length > 0 && (
                <div className="max-w-[200px] truncate text-[11px] text-muted-foreground">
                  {item.bindingsDetail
                    .map((b) => b.accountEmail || `#${b.accountId}`)
                    .join(" · ")}
                </div>
              )}
            </div>
          )}
        </TableCell>

        {/* ③ 状态 · 到期 */}
        <TableCell className="align-top">
          <div className="flex flex-col gap-1">
            <Badge variant={statusVariant(item.status)} className="w-fit">
              {item.status}
            </Badge>
            {exp && (
              <span className={`whitespace-nowrap text-xs ${expColor}`}>
                {exp.text}
              </span>
            )}
          </div>
        </TableCell>

        {/* ④ 额度 */}
        <TableCell className="align-top">
          <QuotaCell
            cardType={item.cardType}
            buckets={item.buckets}
            weight={item.weight}
            shareCapacity={shareCapacity}
          />
        </TableCell>

        {/* ⑤ 操作:编辑 / 用量 / 启停 / 删除 */}
        <TableCell className="align-top">
          <div className="flex items-center justify-end gap-1">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => onEdit(item)}
                    />
                  }
                >
                  <PencilIcon data-icon className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>编辑</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => onUsage(item)}
                    />
                  }
                >
                  <BarChart3Icon data-icon className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>用量</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => onToggle(item)}
                    />
                  }
                >
                  {item.status === "active" ? (
                    <PauseIcon data-icon className="size-3.5" />
                  ) : (
                    <PlayIcon data-icon className="size-3.5" />
                  )}
                </TooltipTrigger>
                <TooltipContent>
                  {item.status === "active" ? "禁用" : "启用"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => onDelete(item)}
                    />
                  }
                >
                  <Trash2Icon data-icon className="size-3.5 text-destructive" />
                </TooltipTrigger>
                <TooltipContent>删除</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </TableCell>
      </TableRow>

      {/* 行展开:次要信息(异常 / 客户端ID / 最后使用 / 逐模型用量明细) */}
      {isOpen && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell />
          <TableCell colSpan={5} className="py-3">
            <div className="flex flex-col gap-3">
              {/* 元信息一行(响应式 grid) */}
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
                <MetaItem label="异常">
                  {anomaly > 0 ? (
                    <span className="flex items-center gap-1 text-destructive">
                      <TriangleAlertIcon data-icon className="size-3" />
                      {anomaly}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">无</span>
                  )}
                </MetaItem>
                <MetaItem label="客户端 ID">
                  <span className="font-mono text-muted-foreground">
                    {item.sessionClientId || "未绑定"}
                  </span>
                </MetaItem>
                <MetaItem label="最后使用">
                  <span className="text-muted-foreground">
                    {formatDateTime(item.lastUsedAt)}
                  </span>
                </MetaItem>
                <MetaItem label="限流窗口">
                  <span className="text-muted-foreground">
                    每 {formatDuration(item.windowMs)}
                  </span>
                </MetaItem>
                <MetaItem label="本窗口 Token">
                  <span className="tabular-nums text-muted-foreground">
                    {formatTokens(Number(item.recentWindowTokens || 0))}
                  </span>
                </MetaItem>
                <MetaItem label="创建时间">
                  <span className="text-muted-foreground">
                    {formatDateTime(item.createdAt)}
                  </span>
                </MetaItem>
              </div>

              {/* 逐模型用量明细(展开里展示全部桶,含未设上限的 ∞) */}
              {item.buckets.length > 0 && (
                <div className="flex flex-col gap-1.5 border-t pt-2">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    逐模型用量
                  </span>
                  <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                    {item.buckets.map((b) => {
                      const limit = Number(b.limit || 0);
                      return (
                        <div
                          key={b.bucket}
                          className="flex items-center justify-between gap-2 text-xs"
                        >
                          <Badge variant="secondary" className="text-[10px]">
                            {b.label}
                          </Badge>
                          <span className="tabular-nums text-muted-foreground">
                            {formatTokens(Number(b.used || 0))} /{" "}
                            {limit > 0 ? formatTokens(limit) : "∞"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** 行展开里的一个「标签 + 值」小块。 */
function MetaItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </span>
      <div>{children}</div>
    </div>
  );
}
