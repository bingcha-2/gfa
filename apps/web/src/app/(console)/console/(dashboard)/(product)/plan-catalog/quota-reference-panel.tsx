import { ExternalLinkIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface QuotaReferencePool {
  product: "codex" | "anthropic";
  level: string;
  label: string;
  fiveHour: number;
  weekly: number;
  fixedPerShare?: {
    fiveHour: number;
    weekly: number;
  };
  status?: string;
}

const SNAPSHOT_DATE = "2026-08-13";
const DEFAULT_BASE_SHARES = 8;
const DEFAULT_OVERSELL_FACTOR = 1.5;

const QUOTA_REFERENCE_POOLS: readonly QuotaReferencePool[] = [
  {
    product: "codex",
    level: "plus",
    label: "Codex Pro 5x",
    fiveHour: 0,
    weekly: 800,
    fixedPerShare: { fiveHour: 0, weekly: 100 },
    status: "每份固定额度",
  },
  {
    product: "codex",
    level: "pro",
    label: "Codex Pro 20x",
    fiveHour: 0,
    weekly: 800,
    fixedPerShare: { fiveHour: 0, weekly: 100 },
    status: "每份固定额度",
  },
  {
    product: "anthropic",
    level: "pro",
    label: "Claude Pro",
    fiveHour: 18,
    weekly: 190,
  },
  {
    product: "anthropic",
    level: "max-5x",
    label: "Claude Max 5x",
    fiveHour: 90,
    weekly: 950,
  },
  {
    product: "anthropic",
    level: "max-20x",
    label: "Claude Max 20x",
    fiveHour: 360,
    weekly: 1_900,
  },
];

const REFERENCE_SOURCES = [
  { label: "OpenAI 官方价格", href: "https://learn.chatgpt.com/docs/pricing" },
  { label: "订阅满载压力测试", href: "https://www.techspot.com/news/112759-openai-anthropic-cant-afford-have-everyone-use-ai.html" },
  { label: "Anthropic 官方说明", href: "https://support.claude.com/en/articles/11049741-what-is-the-max-plan" },
  { label: "Claude 连续窗口实测", href: "https://www.reddit.com/r/ClaudeCode/comments/1umycyw/i_logged_my_own_claude_max_20x_usage_every_5_min/" },
] as const;

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 6,
});

const WHOLE_USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function QuotaReferencePanel({
  oversellFactor,
  baseShares = DEFAULT_BASE_SHARES,
}: {
  oversellFactor?: string | number;
  baseShares?: number;
}) {
  const normalizedBaseShares = positiveInteger(baseShares, DEFAULT_BASE_SHARES);
  const normalizedOversellFactor = normalizeOversellFactor(oversellFactor);
  // Keep this exactly aligned with the server's oversellCeiling(): ceil(C × factor).
  const sellableShares = Math.ceil(normalizedBaseShares * normalizedOversellFactor);

  return (
    <section aria-labelledby="quota-reference-title" className="overflow-hidden rounded-lg border bg-muted/20">
      <div className="flex flex-col gap-2 border-b px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id="quota-reference-title" className="text-sm font-medium">
            母号额度池参考
          </h3>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            满额使用时的 API 原价等价额度，不是现金余额。Codex 每个基础份额固定 $100/周，不随超卖倍率稀释；Claude 单份建议值按 {normalizedBaseShares} 个基础份额 × {formatFactor(normalizedOversellFactor)} 倍超卖，共 {sellableShares} 份换算。
          </p>
        </div>
        <Badge variant="outline" className="shrink-0 bg-background/70 font-mono">
          资料快照 {SNAPSHOT_DATE}
        </Badge>
      </div>

      <Table className="min-w-[760px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-3">母号档位</TableHead>
            <TableHead>目录等级</TableHead>
            <TableHead className="text-right">整号 · 5h</TableHead>
            <TableHead className="text-right">整号 · 周</TableHead>
            <TableHead className="text-right">单份 · 5h</TableHead>
            <TableHead className="text-right">单份 · 周</TableHead>
            <TableHead className="pr-3">状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {QUOTA_REFERENCE_POOLS.map((pool) => {
            const wholeFiveHour = pool.fixedPerShare
              ? pool.fixedPerShare.fiveHour * normalizedBaseShares
              : pool.fiveHour;
            const wholeWeekly = pool.fixedPerShare
              ? pool.fixedPerShare.weekly * normalizedBaseShares
              : pool.weekly;
            const perShareFiveHour = pool.fixedPerShare?.fiveHour ?? pool.fiveHour / sellableShares;
            const perShareWeekly = pool.fixedPerShare?.weekly ?? pool.weekly / sellableShares;

            return (
              <TableRow key={`${pool.product}-${pool.level}`}>
                <TableCell className="pl-3 font-medium">{pool.label}</TableCell>
                <TableCell>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{pool.level}</code>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatWholeUsd(wholeFiveHour)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatWholeUsd(wholeWeekly)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatUsd(perShareFiveHour)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatUsd(perShareWeekly)}</TableCell>
                <TableCell className="pr-3 text-xs text-muted-foreground">
                  {pool.status ?? "常规窗口"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <div className="flex flex-col gap-2 border-t px-3 py-2.5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>默认值取满载实测的运营中值；模型组合不同会造成金额波动，厂商调整额度后需人工复核。</span>
        <nav aria-label="母号额度参考资料" className="flex flex-wrap gap-x-3 gap-y-1">
          {REFERENCE_SOURCES.map((source) => (
            <a
              key={source.href}
              href={source.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {source.label}
              <ExternalLinkIcon aria-hidden="true" className="size-3" />
            </a>
          ))}
        </nav>
      </div>
    </section>
  );
}

function formatUsd(value: number): string {
  return USD_FORMATTER.format(value);
}

function formatWholeUsd(value: number): string {
  return WHOLE_USD_FORMATTER.format(value);
}

function normalizeOversellFactor(value: string | number | undefined): number {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) {
    return DEFAULT_OVERSELL_FACTOR;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_OVERSELL_FACTOR;
  return Math.max(1, parsed);
}

function positiveInteger(value: number, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatFactor(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 }).format(value);
}
