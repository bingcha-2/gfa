"use client";

import { useState, useEffect, useCallback } from "react";
import { apiRequest, getErrorMessage } from "@/lib/client-api";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Pagination, PaginationContent, PaginationItem, PaginationLink,
  PaginationNext, PaginationPrevious, PaginationEllipsis,
} from "@/components/ui/pagination";
import { Play, Save, RefreshCw, Loader2, Clock, CheckCircle2, XCircle, AlertTriangle, Pause } from "lucide-react";

type SchedulerConfig = {
  id: string; enabled: boolean; maxAccountsPerRun: number; accountCooldownMinutes: number;
  runWindowStart: string; runWindowEnd: string; staleSyncThresholdMinutes: number;
  syncEnabled: boolean; removeExpiredMembersEnabled: boolean;
  cancelTimedOutInvitesEnabled: boolean; deduplicateMembersEnabled: boolean;
  inviteTimeoutDays: number; lastRunAt: string | null; lastRunStatus: string | null; lastRunSummary: string | null;
};

type SchedulerStatus = {
  isRunning: boolean; runningSince: string | null; remainingLockSeconds: number;
  lastRunAt: string | null; lastRunStatus: string | null;
  lastRunSummary: { totalAccounts: number; processedAccounts: number; syncTasks: number; removeTasks: number; cancelledInvites: number; deduplicatedMembers: number; errors: string[] } | null;
};

type SchedulerTask = {
  id: string; type: string; status: string; source: string; payload: string;
  lastErrorCode: string | null; lastErrorMessage: string | null;
  startedAt: string | null; finishedAt: string | null; createdAt: string;
  familyGroup: { id: string; groupName: string } | null;
  account: { id: string; name: string; loginEmail: string } | null;
};

const TYPE_LABELS: Record<string, string> = { SYNC_FAMILY_GROUP: "同步", REMOVE_MEMBER: "踢人", INVITE_MEMBER: "邀请", REPLACE_MEMBER: "替换" };
const PAGE_SIZE = 15;

function fmtTime(iso: string | null): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function statusBadge(s: string) {
  if (["SUCCESS", "INVITE_SENT", "REPLACED_AND_INVITE_SENT"].includes(s)) return <Badge variant="default" className="text-xs">{s}</Badge>;
  if (["PENDING", "RUNNING"].includes(s)) return <Badge variant="secondary" className="text-xs">{s}</Badge>;
  return <Badge variant="destructive" className="text-xs">{s}</Badge>;
}

export default function SchedulerPage() {
  const [config, setConfig] = useState<SchedulerConfig | null>(null);
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [tasks, setTasks] = useState<SchedulerTask[]>([]);
  const [taskTotal, setTaskTotal] = useState(0);
  const [taskPage, setTaskPage] = useState(1);
  const [draft, setDraft] = useState<Partial<SchedulerConfig>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (page = taskPage) => {
    try {
      const [c, s, t] = await Promise.all([
        apiRequest<SchedulerConfig>("scheduler/config"),
        apiRequest<SchedulerStatus>("scheduler/status"),
        apiRequest<{ data: SchedulerTask[]; total: number }>(`scheduler/tasks?page=${page}&pageSize=${PAGE_SIZE}`),
      ]);
      setConfig(c); setStatus(s); setTasks(t.data); setTaskTotal(t.total); setTaskPage(page); setDraft({});
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setLoading(false); }
  }, [taskPage]);

  useEffect(() => { load(); const i = setInterval(load, 15_000); return () => clearInterval(i); }, [load]);

  async function saveConfig() {
    if (!config || Object.keys(draft).length === 0) return;
    setSaving(true);
    try {
      const updated = await apiRequest<SchedulerConfig>("scheduler/config", { method: "PATCH", body: draft });
      setConfig(updated); setDraft({}); toast.success("配置已保存");
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setSaving(false); }
  }

  async function triggerRun() {
    try {
      const res = await apiRequest<{ started: boolean; reason?: string }>("scheduler/run", { method: "POST" });
      if (res.started) { toast.success("手动执行已触发"); setTimeout(load, 2000); }
      else toast.info(res.reason || "调度器正在运行中");
    } catch (err) { toast.error(getErrorMessage(err)); }
  }

  const merged = { ...config, ...draft } as SchedulerConfig;
  const hasDraft = Object.keys(draft).length > 0;
  const summary = status?.lastRunSummary;

  function field<K extends keyof SchedulerConfig>(key: K, val: SchedulerConfig[K]) {
    setDraft((p) => ({ ...p, [key]: val }));
  }

  if (loading || !config || !status) {
    return <div className="space-y-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}</div>;
  }

  const totalPages = Math.ceil(taskTotal / PAGE_SIZE);

  return (
    <div className="space-y-6">
      {/* Status + Config side by side */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Status */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {status.isRunning ? <Loader2 className="h-5 w-5 animate-spin text-emerald-500" /> : !merged.enabled ? <Pause className="h-5 w-5 text-muted-foreground" /> : <CheckCircle2 className="h-5 w-5 text-emerald-500" />}
              运行状态
            </CardTitle>
            <CardDescription>
              {status.isRunning ? "运行中" : !merged.enabled ? "已关闭" : "空闲待命"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {status.lastRunAt && <div className="text-sm"><span className="text-muted-foreground">上次执行：</span>{fmtTime(status.lastRunAt)}</div>}
            {status.lastRunStatus && (
              <div className="text-sm"><span className="text-muted-foreground">结果：</span>
                {status.lastRunStatus === "SUCCESS" ? "✓ 成功" : status.lastRunStatus === "PARTIAL" ? "⚠ 部分成功" : status.lastRunStatus === "SKIPPED" ? "○ 无候选" : "✗ 失败"}
              </div>
            )}
            {status.isRunning && status.remainingLockSeconds > 0 && (
              <div className="text-sm text-muted-foreground">超时保护：{Math.ceil(status.remainingLockSeconds / 60)} 分钟后释放锁</div>
            )}
            <AlertDialog>
              <AlertDialogTrigger render={<Button className="w-full mt-2" disabled={status.isRunning} />}>
                <Play className="h-4 w-4 mr-2" />{status.isRunning ? "执行中..." : "立即执行"}
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认立即执行？</AlertDialogTitle>
                  <AlertDialogDescription>将跳过时间窗口限制，立即开始一轮自动维护。</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void triggerRun()}>确认执行</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardContent>
        </Card>

        {/* Config */}
        <Card>
          <CardHeader>
            <CardTitle>维护配置</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <Label>启用自动维护</Label>
              <Switch checked={merged.enabled} onCheckedChange={(v) => field("enabled", v)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">窗口开始</Label><Input type="time" value={merged.runWindowStart} onChange={(e) => field("runWindowStart", e.target.value)} className="mt-1" /></div>
              <div><Label className="text-xs">窗口结束</Label><Input type="time" value={merged.runWindowEnd} onChange={(e) => field("runWindowEnd", e.target.value)} className="mt-1" /></div>
              <div><Label className="text-xs">每轮上限</Label><Input type="number" min={1} max={100} value={merged.maxAccountsPerRun} onChange={(e) => field("maxAccountsPerRun", parseInt(e.target.value) || 1)} className="mt-1" /></div>
              <div><Label className="text-xs">冷却(分钟)</Label><Input type="number" min={5} value={merged.accountCooldownMinutes} onChange={(e) => field("accountCooldownMinutes", parseInt(e.target.value) || 60)} className="mt-1" /></div>
              <div><Label className="text-xs">同步阈值(分钟)</Label><Input type="number" min={60} value={merged.staleSyncThresholdMinutes} onChange={(e) => field("staleSyncThresholdMinutes", parseInt(e.target.value) || 1440)} className="mt-1" /></div>
              <div><Label className="text-xs">邀请超时(天)</Label><Input type="number" min={1} value={merged.inviteTimeoutDays} onChange={(e) => field("inviteTimeoutDays", parseInt(e.target.value) || 3)} className="mt-1" /></div>
            </div>
            <div className="space-y-2 pt-2 border-t">
              <p className="text-xs font-medium text-muted-foreground">执行步骤</p>
              <div className="flex items-center justify-between"><Label className="text-sm">同步家庭组</Label><Switch checked={merged.syncEnabled} onCheckedChange={(v) => field("syncEnabled", v)} /></div>
              <div className="flex items-center justify-between"><Label className="text-sm">踢出到期成员</Label><Switch checked={merged.removeExpiredMembersEnabled} onCheckedChange={(v) => field("removeExpiredMembersEnabled", v)} /></div>
              <div className="flex items-center justify-between"><Label className="text-sm">取消超时邀请</Label><Switch checked={merged.cancelTimedOutInvitesEnabled} onCheckedChange={(v) => field("cancelTimedOutInvitesEnabled", v)} /></div>
              <div className="flex items-center justify-between"><Label className="text-sm">跨组去重</Label><Switch checked={merged.deduplicateMembersEnabled} onCheckedChange={(v) => field("deduplicateMembersEnabled", v)} /></div>
            </div>
            <Button onClick={saveConfig} disabled={saving || !hasDraft} className="w-full">
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}保存配置
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Summary chips */}
      {summary && (
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">同步 {summary.syncTasks}</Badge>
          <Badge variant="outline">踢人 {summary.removeTasks}</Badge>
          <Badge variant="outline">取消邀请 {summary.cancelledInvites}</Badge>
          <Badge variant="outline">去重 {summary.deduplicatedMembers}</Badge>
          {summary.errors.length > 0 && <Badge variant="destructive">错误 {summary.errors.length}</Badge>}
        </div>
      )}

      {/* Task timeline */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>执行日志（最近 3 天）</CardTitle>
            {taskTotal > 0 && <CardDescription>共 {taskTotal} 条</CardDescription>}
          </div>
        </CardHeader>
        <CardContent>
          {tasks.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">暂无执行记录</p>
          ) : (
            <>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-24">时间</TableHead>
                      <TableHead className="w-16">类型</TableHead>
                      <TableHead>详情</TableHead>
                      <TableHead className="w-24">状态</TableHead>
                      <TableHead>错误</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tasks.map((task) => {
                      let email = "";
                      try { const p = JSON.parse(task.payload); email = p.memberEmail || p.userEmail || ""; } catch {}
                      return (
                        <TableRow key={task.id}>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtTime(task.startedAt || task.createdAt)}</TableCell>
                          <TableCell><Badge variant="outline" className="text-xs">{TYPE_LABELS[task.type] ?? task.type}</Badge></TableCell>
                          <TableCell className="text-xs">
                            {task.familyGroup?.groupName && <span>{task.familyGroup.groupName}</span>}
                            {email && <span className="text-muted-foreground"> · {email}</span>}
                            {task.account && <span className="text-muted-foreground"> ← {task.account.loginEmail}</span>}
                            {task.source === "expire-scan" && <Badge variant="secondary" className="text-xs ml-1">到期扫描</Badge>}
                          </TableCell>
                          <TableCell>{statusBadge(task.status)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-48 truncate">{task.lastErrorMessage || "-"}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              {totalPages > 1 && (
                <Pagination className="mt-4">
                  <PaginationContent>
                    <PaginationItem><PaginationPrevious onClick={() => load(taskPage - 1)} className={taskPage <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"} /></PaginationItem>
                    {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i + 1).map((p) => (
                      <PaginationItem key={p}><PaginationLink isActive={p === taskPage} onClick={() => load(p)} className="cursor-pointer">{p}</PaginationLink></PaginationItem>
                    ))}
                    {totalPages > 5 && <PaginationItem><PaginationEllipsis /></PaginationItem>}
                    <PaginationItem><PaginationNext onClick={() => load(taskPage + 1)} className={taskPage >= totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"} /></PaginationItem>
                  </PaginationContent>
                </Pagination>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
