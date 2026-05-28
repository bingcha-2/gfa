import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Spinner } from "@/components/ui/spinner";
import { Lock, Unlock, ChevronLeft, ChevronRight } from "lucide-react";

import type { Credits, EnrichedAccount } from "./types";
import { formatMs, formatTokenCount, formatDateTime, successRateColor } from "./helpers";
import { REASON_LABELS, getQuotaDisplayItem, PAGE_SIZE } from "./constants";
import type { CanonicalModel } from "./types";
import { ModelQuotaCell } from "./model-quota-cell";

export function AccountsTable({
  filteredAccounts,
  pageAccounts,
  page,
  totalPages,
  safePage,
  selectedIds,
  visibleCols,
  visibleModelQuotaOptions,
  togglingIds,
  summaryReasons,
  search,
  onPageChange,
  onToggleSelectAll,
  onToggleSelect,
  onToggleAccount,
}: {
  filteredAccounts: EnrichedAccount[];
  pageAccounts: EnrichedAccount[];
  page: number;
  totalPages: number;
  safePage: number;
  selectedIds: Set<string>;
  visibleCols: Set<string>;
  visibleModelQuotaOptions: CanonicalModel[];
  togglingIds: Set<string>;
  summaryReasons: { okCount: number; reasons: Record<string, number> };
  search: string;
  onPageChange: (page: number) => void;
  onToggleSelectAll: (checked: boolean) => void;
  onToggleSelect: (id: string) => void;
  onToggleAccount: (id: string, currentlyEnabled: boolean) => void;
}) {
  const show = (key: string) => visibleCols.has(key);

  return (
    <>
      {/* Summary Bar */}
      {filteredAccounts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary" className="tabular-nums">
            <span className="font-bold text-primary">{summaryReasons.okCount}</span>
            &nbsp;正常
          </Badge>
          {Object.entries(summaryReasons.reasons)
            .sort((a, b) => b[1] - a[1])
            .map(([r, count]) => (
              <Badge key={r} variant="secondary" className="tabular-nums">
                <span className="font-bold text-red-400">{count}</span>
                &nbsp;{REASON_LABELS[r] || r}
              </Badge>
            ))}
        </div>
      )}

      {/* Table */}
      {filteredAccounts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {search.trim() ? "没有匹配的负载数据" : "暂无账号负载数据"}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8">
                        <Checkbox
                          checked={
                            pageAccounts.length > 0 &&
                            pageAccounts.every((a) => selectedIds.has(String(a.id)))
                          }
                          onCheckedChange={(checked) => onToggleSelectAll(!!checked)}
                        />
                      </TableHead>
                      {show("account") && <TableHead>账号</TableHead>}
                      {show("plan") && <TableHead>套餐</TableHead>}
                      {show("credits") && <TableHead>AI积分</TableHead>}
                      {show("modelQuota") &&
                        visibleModelQuotaOptions.map((model) => (
                          <TableHead key={model.id}>{model.displayName}</TableHead>
                        ))}
                      {show("quotaStatus") && <TableHead>额度状态</TableHead>}
                      {show("reason") && <TableHead>封禁原因</TableHead>}
                      {show("cooldown") && <TableHead>冷却/剩余</TableHead>}
                      {show("blockedModels") && <TableHead>阻断模型</TableHead>}
                      {show("lease") && <TableHead>Lease</TableHead>}
                      {show("totalTokens") && <TableHead>累计Token</TableHead>}
                      {show("successRate") && <TableHead>成功率</TableHead>}
                      {show("reqFail") && <TableHead>请求/失败</TableHead>}
                      {show("locationFail") && <TableHead>地区失败</TableHead>}
                      {show("lastConversation") && <TableHead>最近对话</TableHead>}
                      {show("lastCode") && <TableHead>最近码</TableHead>}
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageAccounts.map((account) => {
                      const id = String(account.id);
                      const isDisabled = account.enabled === false;
                      const reason = account.quotaStatusReason || "";
                      const reasonLabel = ({
                        quota: "额度耗尽",
                        capacity: "容量限制",
                        location_unsupported: "地区不支持",
                        location_permanent_ban: "地区永封",
                        token_refresh_failed: "Token失效",
                        phone_verification_required: "手机验证",
                        auth_forbidden: "认证被拒",
                        auth_failed: "认证失败",
                        verification_required: "需验证",
                        quota_cooling: "冷却中",
                      } as Record<string, string>)[reason] || reason || "-";
                      const reasonDot =
                        reason.includes("permanent") || reason.includes("token_refresh")
                          ? "bg-red-500"
                          : reason
                            ? "bg-yellow-500"
                            : "bg-green-500";
                      const quotaStatus = String(account.quotaStatus || "").toLowerCase();
                      const quotaDotClass =
                        isDisabled || quotaStatus === "error"
                          ? "bg-red-500"
                          : quotaStatus === "exhausted" || quotaStatus === "cooling"
                            ? "bg-yellow-500"
                            : "bg-green-500";
                      const credits = account.credits || ({} as Credits);
                      const creditsDotClass = credits.available ? "bg-green-500" : "bg-red-500";
                      const modelQuotaFractions = account.modelQuotaFractions || {};

                      return (
                        <TableRow
                          key={id}
                          className={isDisabled ? "opacity-50" : undefined}
                        >
                          <TableCell>
                            <Checkbox
                              checked={selectedIds.has(id)}
                              onCheckedChange={() => onToggleSelect(id)}
                            />
                          </TableCell>
                          {show("account") && (
                            <TableCell className="font-mono text-xs whitespace-nowrap">
                              <span className="text-muted-foreground">#{id}</span>
                              <br />
                              {account.email || ""}
                            </TableCell>
                          )}
                          {show("plan") && (
                            <TableCell className="text-xs">{account.planType || "-"}</TableCell>
                          )}
                          {show("credits") && (
                            <TableCell className="text-xs">
                              {credits.known ? (
                                <Tooltip>
                                  <TooltipTrigger className="inline-flex items-center gap-1">
                                    <span
                                      className={`inline-block size-1.5 rounded-full ${creditsDotClass}`}
                                    />
                                    <span className={credits.available ? "" : "text-red-500"}>
                                      {Number(credits.creditAmount || 0).toLocaleString(
                                        undefined,
                                        { maximumFractionDigits: 0 },
                                      )}
                                      <span className="text-muted-foreground">/{credits.minCreditAmount || 0}</span>
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    余额: {credits.creditAmount} / 最低:{" "}
                                    {credits.minCreditAmount || 0}
                                    {!credits.available && <><br />低于最低使用门槛</>}
                                    <br />
                                    刷新:{" "}
                                    {credits.creditsRefreshedAt
                                      ? new Date(credits.creditsRefreshedAt).toLocaleString()
                                      : "未刷新"}
                                  </TooltipContent>
                                </Tooltip>
                              ) : (
                                <Tooltip>
                                  <TooltipTrigger className="inline-flex items-center gap-1 text-muted-foreground">
                                    <span className="inline-block size-1.5 rounded-full bg-muted-foreground/40" />
                                    未知
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Google 未返回 AI 积分数据
                                    <br />
                                    刷新:{" "}
                                    {credits.creditsRefreshedAt
                                      ? new Date(credits.creditsRefreshedAt).toLocaleString()
                                      : "未刷新"}
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </TableCell>
                          )}
                          {show("modelQuota") &&
                            visibleModelQuotaOptions.map((model) => (
                              <TableCell key={model.id}>
                                <ModelQuotaCell
                                  item={getQuotaDisplayItem(
                                    model.id,
                                    modelQuotaFractions,
                                    account.modelQuotaResetTimes,
                                  )}
                                  refreshedAt={account.modelQuotaRefreshedAt}
                                />
                              </TableCell>
                            ))}
                          {show("quotaStatus") && (
                            <TableCell className="text-xs">
                              <span className="inline-flex items-center gap-1">
                                <span
                                  className={`inline-block size-1.5 rounded-full ${quotaDotClass}`}
                                />
                                {account.quotaStatus || "unknown"}
                              </span>
                            </TableCell>
                          )}
                          {show("reason") && (
                            <TableCell className="text-xs">
                              <span className="inline-flex items-center gap-1">
                                <span
                                  className={`inline-block size-1.5 rounded-full ${reasonDot}`}
                                />
                                {reasonLabel}
                              </span>
                            </TableCell>
                          )}
                          {show("cooldown") && (
                            <TableCell className="text-xs tabular-nums">
                              {formatMs(account._cooldownMs || 0)}
                            </TableCell>
                          )}
                          {show("blockedModels") && (
                            <TableCell className="text-xs max-w-[180px]">
                              {account._blockedModels.length > 0 ? (
                                <div className="flex flex-col gap-0.5">
                                  {account._blockedModels.slice(0, 3).map((m, i) => {
                                    const short = (m.modelKey || "")
                                      .replace(/^(tab_|models\/)/, "")
                                      .slice(0, 18);
                                    const remaining = Math.max(0, m.blockedUntil - Date.now());
                                    return (
                                      <Tooltip key={i}>
                                        <TooltipTrigger className="text-left">
                                          <code className="text-[11px]">{short}</code>{" "}
                                          <span className="text-muted-foreground text-[10px]">
                                            {formatMs(remaining)}
                                          </span>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          {m.modelKey} ({m.reason})
                                        </TooltipContent>
                                      </Tooltip>
                                    );
                                  })}
                                  {account._blockedModels.length > 3 && (
                                    <span className="text-[10px] text-muted-foreground">
                                      +{account._blockedModels.length - 3} more
                                    </span>
                                  )}
                                </div>
                              ) : (
                                "-"
                              )}
                            </TableCell>
                          )}
                          {show("lease") && (
                            <TableCell className="text-xs tabular-nums">
                              {account._activeLeases}
                            </TableCell>
                          )}
                          {show("totalTokens") && (
                            <TableCell className="text-xs tabular-nums">
                              {account._totalTokensUsed > 0 ? (
                                <Tooltip>
                                  <TooltipTrigger>
                                    {formatTokenCount(account._totalTokensUsed)}
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    输入: {account._totalInputTokens.toLocaleString()} / 输出:{" "}
                                    {account._totalOutputTokens.toLocaleString()}
                                  </TooltipContent>
                                </Tooltip>
                              ) : (
                                "-"
                              )}
                            </TableCell>
                          )}
                          {show("successRate") && (
                            <TableCell
                              className={`text-xs tabular-nums font-medium ${successRateColor(account._successRate)}`}
                            >
                              {account._successRate != null
                                ? `${Math.round(account._successRate)}%`
                                : "无数据"}
                            </TableCell>
                          )}
                          {show("reqFail") && (
                            <TableCell className="text-xs tabular-nums">
                              {account._total} / {account._failures}
                            </TableCell>
                          )}
                          {show("locationFail") && (
                            <TableCell className="text-xs">
                              {account._locationFailures > 0 ? (
                                <span className="inline-flex items-center gap-1">
                                  <span
                                    className={`inline-block size-1.5 rounded-full ${account._locationFailures >= 10 ? "bg-red-500" : "bg-yellow-500"}`}
                                  />
                                  {account._locationFailures}
                                </span>
                              ) : (
                                "-"
                              )}
                            </TableCell>
                          )}
                          {show("lastConversation") && (
                            <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                              {formatDateTime(account.lastConversationOkAt) || "-"}
                            </TableCell>
                          )}
                          {show("lastCode") && (
                            <TableCell className="text-xs text-muted-foreground">
                              {account._lastStatus || "-"}
                            </TableCell>
                          )}
                          <TableCell>
                            <Button
                              variant={isDisabled ? "outline" : "destructive"}
                              size="xs"
                              disabled={togglingIds.has(id)}
                              onClick={() => onToggleAccount(id, account.enabled !== false)}
                            >
                              {togglingIds.has(id) ? (
                                <Spinner size={12} />
                              ) : isDisabled ? (
                                <>
                                  <Unlock data-icon />
                                  解封
                                </>
                              ) : (
                                <>
                                  <Lock data-icon />
                                  禁用
                                </>
                              )}
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 py-3 border-t">
                  <Button
                    variant="outline"
                    size="icon-xs"
                    disabled={safePage <= 1}
                    onClick={() => onPageChange(safePage - 1)}
                  >
                    <ChevronLeft />
                  </Button>
                  <div className="flex items-center gap-1">
                    {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                      let pageNum: number;
                      if (totalPages <= 7) {
                        pageNum = i + 1;
                      } else if (safePage <= 4) {
                        pageNum = i + 1;
                      } else if (safePage >= totalPages - 3) {
                        pageNum = totalPages - 6 + i;
                      } else {
                        pageNum = safePage - 3 + i;
                      }
                      return (
                        <Button
                          key={pageNum}
                          variant={pageNum === safePage ? "default" : "ghost"}
                          size="icon-xs"
                          onClick={() => onPageChange(pageNum)}
                        >
                          {pageNum}
                        </Button>
                      );
                    })}
                  </div>
                  <Button
                    variant="outline"
                    size="icon-xs"
                    disabled={safePage >= totalPages}
                    onClick={() => onPageChange(safePage + 1)}
                  >
                    <ChevronRight />
                  </Button>
                  <span className="text-xs text-muted-foreground ml-2">
                    {safePage} / {totalPages} 页
                  </span>
                </div>
              )}
            </>
          </CardContent>
        </Card>
      )}
    </>
  );
}
