import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

import type { DailyStats, EnterpriseProbeGroup } from "./types";
import { formatTokenCount, successRateColor, pressureColor } from "./helpers";

type ModelPressureItem = {
  model: string;
  count: number;
  total: number;
  pct: number;
};

type OverviewStats = {
  activeLeases: number;
  clients: number;
  successRate: number;
  totalAllTokens: number;
  dailyRate: number;
};

export function ServerOverviewPanel({
  overviewStats,
  daily,
  modelPressure,
  enterpriseGroups,
}: {
  overviewStats: OverviewStats;
  daily: DailyStats;
  modelPressure: ModelPressureItem[];
  enterpriseGroups: [string, EnterpriseProbeGroup][];
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {/* Left: 服务器概况 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">服务器概况</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-2xl font-bold text-primary">
                {overviewStats.activeLeases}
              </div>
              <div className="text-xs text-muted-foreground">活跃 Lease</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-primary">
                {overviewStats.clients}
              </div>
              <div className="text-xs text-muted-foreground">绑定客户端</div>
            </div>
            <div>
              <div
                className={`text-2xl font-bold ${successRateColor(overviewStats.successRate)}`}
              >
                {overviewStats.successRate}%
              </div>
              <div className="text-xs text-muted-foreground">总成功率</div>
            </div>
          </div>
          <Separator />
          <div>
            <div className="text-xs font-semibold text-muted-foreground mb-2">
              今日统计 ({daily.date || "-"})
            </div>
            <div className="grid grid-cols-5 gap-1 text-center text-xs">
              <div>
                <div className="font-semibold">{daily.leases || 0}</div>
                <div className="text-muted-foreground">租号</div>
              </div>
              <div>
                <div className="font-semibold text-green-500">{daily.successes || 0}</div>
                <div className="text-muted-foreground">成功</div>
              </div>
              <div>
                <div className="font-semibold text-red-500">{daily.errors || 0}</div>
                <div className="text-muted-foreground">失败</div>
              </div>
              <div>
                <div className="font-semibold">{overviewStats.dailyRate}%</div>
                <div className="text-muted-foreground">成功率</div>
              </div>
              <div>
                <div className="font-semibold">
                  {formatTokenCount(daily.tokensUsed || 0)}
                </div>
                <div className="text-muted-foreground">Token</div>
              </div>
            </div>
          </div>
          <div className="text-right text-[11px] text-muted-foreground">
            累计 Token: {formatTokenCount(overviewStats.totalAllTokens)}
          </div>
        </CardContent>
      </Card>

      {/* Right: 模型压力 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            模型压力{" "}
            <span className="font-normal text-muted-foreground text-xs">
              (cooling 中的账号数)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {modelPressure.length === 0 ? (
            <span className="text-xs text-muted-foreground">无阻断</span>
          ) : (
            modelPressure.map((m) => (
              <div key={m.model} className="flex items-center gap-2 text-xs">
                <span className="min-w-[120px] text-muted-foreground truncate">
                  {m.model}
                </span>
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${pressureColor(m.pct)}`}
                    style={{ width: `${m.pct}%` }}
                  />
                </div>
                <span className="min-w-[60px] text-right tabular-nums">
                  {m.count}/{m.total}{" "}
                  <span className="text-muted-foreground">({m.pct}%)</span>
                </span>
              </div>
            ))
          )}

          {/* Enterprise probe */}
          {enterpriseGroups.length > 0 && (
            <>
              <Separator className="my-1" />
              <div className="text-xs font-semibold text-muted-foreground mb-1">
                企业号探测
              </div>
              {enterpriseGroups.map(([name, g]) => {
                const wColor =
                  g.weight >= 6
                    ? "text-green-500"
                    : g.weight >= 3
                      ? "text-primary"
                      : g.weight >= 1.5
                        ? "text-yellow-500"
                        : "text-red-500";
                const statusText = g.emergency
                  ? "⚠️ 紧急降权"
                  : g.rate !== null
                    ? `${g.rate}% 成功`
                    : "探测中…";
                return (
                  <div key={name} className="flex items-center gap-2 text-xs">
                    <span className="min-w-[50px] font-semibold">{name}</span>
                    <span className={`${wColor} font-bold min-w-[60px]`}>
                      权重 {g.weight.toFixed(1)}
                    </span>
                    <span className="text-muted-foreground">{statusText}</span>
                    <span className="text-muted-foreground text-[10px]">
                      {g.successes}ok/{g.failures}fail
                    </span>
                    <span className="ml-auto text-muted-foreground text-[10px]">
                      {g.cycleMinutesLeft}min
                    </span>
                  </div>
                );
              })}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
