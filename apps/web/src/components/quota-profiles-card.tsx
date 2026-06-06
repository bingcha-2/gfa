"use client";

import { useEffect, useState } from "react";
import { BarChart3Icon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type QuotaProfile = {
  window5h: number;
  weekly: number;
  samples5h: number;
  samplesWeekly: number;
  lastUpdatedAt: number;
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}

function timeAgo(ms: number): string {
  if (!ms) return "从未";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

/**
 * QuotaProfilesCard — displays learned quota profiles for a specific product line.
 * Fetches from the status API endpoint and filters profiles by product prefix.
 *
 * @param product   "antigravity" | "codex" | "anthropic"
 * @param statusUrl The status API endpoint to fetch quotaProfiles from
 */
export function QuotaProfilesCard({
  product,
  statusUrl,
}: {
  product: string;
  statusUrl: string;
}) {
  const [profiles, setProfiles] = useState<Record<string, QuotaProfile>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(statusUrl, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data?.quotaProfiles) {
          setProfiles(data.quotaProfiles);
        }
      } catch {
        // silent
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [statusUrl]);

  // Filter profiles by product prefix
  const prefix = `${product}:`;
  const entries = Object.entries(profiles)
    .filter(([key]) => key.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b));

  if (loading) return null;
  if (entries.length === 0) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium">额度档案</CardTitle>
          <BarChart3Icon className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">暂无学习数据，等待 429 事件采样…</p>
        </CardContent>
      </Card>
    );
  }

  // Find latest update time across all profiles
  const latestUpdate = Math.max(...entries.map(([, p]) => p.lastUpdatedAt));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">额度档案 (已学习)</CardTitle>
        <BarChart3Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="space-y-3">
        {entries.map(([key, profile]) => {
          // key = "antigravity:ultra:claude" → extract planType + family
          const parts = key.split(":");
          const planType = parts[1] || "?";
          const family = parts[2] || "?";

          return (
            <div key={key} className="space-y-0.5">
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  {planType}
                </Badge>
                <span className="text-xs font-medium text-muted-foreground">
                  {family}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs">
                {profile.window5h > 0 ? (
                  <span>
                    5h:{" "}
                    <span className="font-semibold tabular-nums">
                      {formatTokens(profile.window5h)}
                    </span>
                    <span className="text-muted-foreground ml-1">
                      ({profile.samples5h} 样本)
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">5h: —</span>
                )}
                {profile.weekly > 0 ? (
                  <span>
                    周:{" "}
                    <span className="font-semibold tabular-nums">
                      {formatTokens(profile.weekly)}
                    </span>
                    <span className="text-muted-foreground ml-1">
                      ({profile.samplesWeekly} 样本)
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">周: —</span>
                )}
              </div>
            </div>
          );
        })}
        <div className="text-[10px] text-muted-foreground pt-1 border-t">
          最后更新: {timeAgo(latestUpdate)}
        </div>
      </CardContent>
    </Card>
  );
}
