"use client";

// 卡密列表工具栏 —— 列表上方一整条交互区(对应设计 §2 的"工具栏")。
// 全部受控、纯展示:不取数、不持有筛选状态,所有值与回调由父(page.tsx)通过 props 注入。
//   - 搜索框(受控 value + onSearchChange;Enter / 按钮 onSearchSubmit;清空 onSearchClear)。
//   - 类型筛选:全部 / 万能(pool)/ 绑定(bound)。
//   - 状态筛选:全部 / active / disabled / expired。
//   - 排序:字段 + 方向(点同字段切方向)。
//   - 概览 chips:共 / 活跃 / 7天内到期 / 已停过期(数值由父算好传入 OverviewCounts)。
//   - 「清理 ▾」菜单:清理过期 / 清理未绑定(回调里弹二次确认由父处理)。
//   - 右侧「+ 生成卡密」主按钮(onCreate)。

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SearchIcon,
  XIcon,
  PlusIcon,
  Trash2Icon,
  UnplugIcon,
  ChevronDownIcon,
  ArrowUpIcon,
  ArrowDownIcon,
} from "lucide-react";
import type { CardType } from "./types";

// ── 筛选 / 排序的取值类型(与 page.tsx 共用)──
/** 类型筛选:全部 / 万能 / 绑定。 */
export type TypeFilter = "all" | CardType;
/** 状态筛选:全部 / active / disabled / expired。 */
export type StatusFilter = "all" | "active" | "disabled" | "expired";
/** 可排序字段(对齐 AccessKeyListItem 的数值/时间字段)。 */
export type SortField =
  | "createdAt"
  | "recentWindowTokens"
  | "totalTokensUsed"
  | "totalRequests"
  | "expiresAt";
export type SortDir = "asc" | "desc";

/** 概览 chips 的四个计数(由父按当前列表算好)。 */
export interface OverviewCounts {
  /** 共多少张。 */
  total: number;
  /** 活跃(active)。 */
  active: number;
  /** 7 天内到期(有 expiresAt 且剩余 0..7d)。 */
  expiringSoon: number;
  /** 已停 / 已过期(disabled 或 expired 或已超期)。 */
  inactive: number;
}

// 下拉项(base-ui Select 需要 items 才能在关闭态正确显示标签)。
const TYPE_ITEMS: { label: string; value: TypeFilter }[] = [
  { label: "全部类型", value: "all" },
  { label: "万能卡", value: "pool" },
  { label: "绑定卡", value: "bound" },
];
const STATUS_ITEMS: { label: string; value: StatusFilter }[] = [
  { label: "全部状态", value: "all" },
  { label: "有效", value: "active" },
  { label: "已禁用", value: "disabled" },
  { label: "已过期", value: "expired" },
];
const SORT_ITEMS: { label: string; value: SortField }[] = [
  { label: "创建时间", value: "createdAt" },
  { label: "窗口 Token", value: "recentWindowTokens" },
  { label: "总 Token", value: "totalTokensUsed" },
  { label: "请求数", value: "totalRequests" },
  { label: "到期时间", value: "expiresAt" },
];

export interface ToolbarProps {
  // ── 搜索 ──
  search: string;
  onSearchChange: (value: string) => void;
  onSearchSubmit: () => void;
  onSearchClear: () => void;

  // ── 筛选 ──
  typeFilter: TypeFilter;
  onTypeFilterChange: (value: TypeFilter) => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (value: StatusFilter) => void;

  // ── 排序 ──
  sortField: SortField;
  sortDir: SortDir;
  onSortFieldChange: (value: SortField) => void;
  onSortDirToggle: () => void;

  // ── 概览 ──
  counts: OverviewCounts;

  // ── 清理菜单 ──
  onCleanupExpired: () => void;
  onCleanupUnbound: () => void;
  cleaning?: boolean;

  // ── 生成 ──
  onCreate: () => void;
}

export function Toolbar({
  search,
  onSearchChange,
  onSearchSubmit,
  onSearchClear,
  typeFilter,
  onTypeFilterChange,
  statusFilter,
  onStatusFilterChange,
  sortField,
  sortDir,
  onSortFieldChange,
  onSortDirToggle,
  counts,
  onCleanupExpired,
  onCleanupUnbound,
  cleaning,
  onCreate,
}: ToolbarProps) {
  return (
    <div className="flex flex-col gap-3">
      {/* ── 第一行:概览 chips(左)+ 生成按钮(右)── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">共 {counts.total.toLocaleString()}</Badge>
          <Badge className="bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400">
            活跃 {counts.active.toLocaleString()}
          </Badge>
          <Badge className="bg-yellow-500/15 text-yellow-600 hover:bg-yellow-500/15 dark:text-yellow-400">
            7天内到期 {counts.expiringSoon.toLocaleString()}
          </Badge>
          <Badge className="bg-muted text-muted-foreground hover:bg-muted">
            已停/过期 {counts.inactive.toLocaleString()}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          {/* 清理 ▾ 菜单 */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="sm" disabled={cleaning} />
              }
            >
              <Trash2Icon data-icon className="size-4" />
              清理
              <ChevronDownIcon data-icon className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={onCleanupExpired}>
                <Trash2Icon data-icon className="size-4" />
                清理过期卡密
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onCleanupUnbound}>
                <UnplugIcon data-icon className="size-4" />
                清理未绑定卡密
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* + 生成卡密(主按钮) */}
          <Button size="sm" onClick={onCreate}>
            <PlusIcon data-icon className="size-4" />
            生成卡密
          </Button>
        </div>
      </div>

      {/* ── 第二行:搜索 + 筛选 + 排序 ── */}
      <div className="flex flex-wrap items-center gap-2">
        {/* 搜索框 */}
        <div className="flex items-center gap-1.5">
          <Input
            className="w-56"
            placeholder="搜索卡密 / 备注 / 状态 / 设备"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSearchSubmit();
              }
            }}
          />
          <Button variant="outline" size="icon-sm" onClick={onSearchSubmit}>
            <SearchIcon data-icon className="size-4" />
          </Button>
          {search && (
            <Button variant="ghost" size="icon-sm" onClick={onSearchClear}>
              <XIcon data-icon className="size-4" />
            </Button>
          )}
        </div>

        <Separator orientation="vertical" className="h-6" />

        {/* 类型筛选 */}
        <Select
          items={TYPE_ITEMS}
          value={typeFilter}
          onValueChange={(v) => onTypeFilterChange(v as TypeFilter)}
        >
          <SelectTrigger className="w-32" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {TYPE_ITEMS.map((it) => (
                <SelectItem key={it.value} value={it.value}>
                  {it.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        {/* 状态筛选 */}
        <Select
          items={STATUS_ITEMS}
          value={statusFilter}
          onValueChange={(v) => onStatusFilterChange(v as StatusFilter)}
        >
          <SelectTrigger className="w-32" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {STATUS_ITEMS.map((it) => (
                <SelectItem key={it.value} value={it.value}>
                  {it.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <Separator orientation="vertical" className="h-6" />

        {/* 排序:字段下拉 + 方向切换 */}
        <span className="text-xs text-muted-foreground">排序</span>
        <Select
          items={SORT_ITEMS}
          value={sortField}
          onValueChange={(v) => onSortFieldChange(v as SortField)}
        >
          <SelectTrigger className="w-32" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {SORT_ITEMS.map((it) => (
                <SelectItem key={it.value} value={it.value}>
                  {it.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon"
          onClick={onSortDirToggle}
          title={sortDir === "desc" ? "降序" : "升序"}
        >
          {sortDir === "desc" ? (
            <ArrowDownIcon data-icon className="size-4" />
          ) : (
            <ArrowUpIcon data-icon className="size-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
