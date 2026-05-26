"use client";

import { useState, useEffect } from "react";
import { apiRequest, getErrorMessage } from "@/lib/client-api";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight, CalendarDays, RefreshCw, Loader2 } from "lucide-react";

type DailyStatsData = {
  date: string;
  importedAccounts: number;
  suspendedAccounts: number;
  verificationAccounts: number;
  transferredMembers: number;
  redeemInvites: number;
  consoleInvites: number;
};

function todayDateStr(): string {
  const now = new Date();
  const offset = now.getTime() + 8 * 60 * 60 * 1000;
  const d = new Date(offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const METRIC_CONFIG: { key: keyof Omit<DailyStatsData, "date">; label: string; desc: string; icon: string; color: string }[] = [
  { key: "importedAccounts", label: "导入母号", desc: "当日新导入的母号数量", icon: "📥", color: "text-blue-500" },
  { key: "suspendedAccounts", label: "订阅暂停", desc: "被暂停订阅的母号数量", icon: "⏸️", color: "text-amber-500" },
  { key: "verificationAccounts", label: "需验证", desc: "触发验证的母号数量", icon: "⚠️", color: "text-orange-500" },
  { key: "transferredMembers", label: "迁移成员", desc: "被迁移的家庭组成员总数", icon: "🔄", color: "text-purple-500" },
  { key: "redeemInvites", label: "卡密邀请", desc: "卡密兑换产生的邀请数", icon: "🎟️", color: "text-emerald-500" },
  { key: "consoleInvites", label: "控制台邀请", desc: "控制台手动发起的邀请", icon: "🖥️", color: "text-cyan-500" },
];

export default function DailyStatsPage() {
  const [date, setDate] = useState(todayDateStr());
  const [stats, setStats] = useState<DailyStatsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function loadStats(targetDate: string) {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiRequest<DailyStatsData>("stats/daily", { search: { date: targetDate } });
      setStats(data);
    } catch (err) {
      setError(getErrorMessage(err));
      setStats(null);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => { loadStats(date); }, []);

  function shiftDate(days: number) {
    const current = new Date(date + "T00:00:00");
    current.setDate(current.getDate() + days);
    const shifted = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`;
    setDate(shifted);
    loadStats(shifted);
  }

  function handleDateChange(newDate: string) {
    setDate(newDate);
    loadStats(newDate);
  }

  const isToday = date === todayDateStr();

  return (
    <div className="space-y-6">
      {/* Date controls */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5" />
                每日数据汇总
              </CardTitle>
              <CardDescription>查看指定日期的运营核心指标</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" onClick={() => shiftDate(-1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Input
                type="date"
                value={date}
                max={todayDateStr()}
                onChange={(e) => handleDateChange(e.target.value)}
                className="w-auto"
              />
              <Button variant="outline" size="icon" onClick={() => shiftDate(1)} disabled={isToday}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleDateChange(todayDateStr())} disabled={isToday}>
                今日
              </Button>
              <Button variant="outline" size="icon" onClick={() => loadStats(date)} disabled={isLoading}>
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-destructive text-sm">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* Metrics grid */}
      {isLoading && !stats ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2"><Skeleton className="h-4 w-20" /></CardHeader>
              <CardContent><Skeleton className="h-10 w-16" /></CardContent>
            </Card>
          ))}
        </div>
      ) : stats ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {METRIC_CONFIG.map((m) => (
            <Card key={m.key} className="relative overflow-hidden">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1.5">
                  <span>{m.icon}</span>
                  {m.label}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className={`text-3xl font-bold tabular-nums ${m.color}`}>
                  {stats[m.key]}
                </div>
                <p className="text-xs text-muted-foreground mt-1">{m.desc}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !error ? (
        <Card>
          <CardContent className="flex items-center justify-center py-16">
            <p className="text-muted-foreground">暂无数据</p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
