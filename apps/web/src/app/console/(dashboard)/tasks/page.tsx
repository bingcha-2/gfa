"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useConsole } from "@/components/console-provider";
import { apiRequest, getErrorMessage } from "@/lib/client-api";
import {
  canCancelTask, canManualCompleteTask, canManualFailTask, canRetryTask,
} from "@/lib/permissions";
import type { TaskSummary } from "@/lib/types";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Pagination, PaginationContent, PaginationItem,
  PaginationLink, PaginationNext, PaginationPrevious, PaginationEllipsis,
} from "@/components/ui/pagination";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input as InputField } from "@/components/ui/input";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { RefreshCw, RotateCcw, CheckCircle2, XCircle, Ban, ChevronDown, Loader2 } from "lucide-react";

const PAGE_SIZE = 50;

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "SUCCESS": case "COMPLETED": case "INVITE_SENT": case "REPLACED_AND_INVITE_SENT": return "default";
    case "PENDING": case "QUEUED": case "RUNNING": return "secondary";
    case "FAILED": case "FAILED_FINAL": case "FAILED_RETRYABLE": case "CANCELLED": return "destructive";
    default: return "outline";
  }
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function fmtDuration(ms: number): string {
  if (ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function TaskTimer({ task }: { task: TaskSummary }) {
  const isRunning = task.status === "RUNNING";
  const [elapsed, setElapsed] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isRunning || !task.startedAt) { setElapsed(null); return; }
    const start = new Date(task.startedAt).getTime();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isRunning, task.startedAt]);

  let durationLabel: string | null = null;
  if (!isRunning && task.startedAt && task.finishedAt) {
    durationLabel = fmtDuration(new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime());
  } else if (!isRunning && task.startedAt && task.updatedAt) {
    const ms = new Date(task.updatedAt).getTime() - new Date(task.startedAt).getTime();
    if (ms > 0) durationLabel = fmtDuration(ms);
  }

  return (
    <div className="text-xs text-muted-foreground mt-1 space-x-2">
      <span>🕐 {fmtTime(task.createdAt)}</span>
      {isRunning && elapsed !== null && (
        <span className="text-emerald-500 font-medium">⏱ {fmtDuration(elapsed)}</span>
      )}
      {!isRunning && durationLabel && <span>⏱ {durationLabel}</span>}
    </div>
  );
}

type ActioningState = { taskId: string; action: string } | null;

export default function TasksPage() {
  const { user } = useConsole();
  const role = user.role;
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [activeTab, setActiveTab] = useState<"all" | "manual" | "retryable">("all");
  const [filter, setFilter] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [actioning, setActioning] = useState<ActioningState>(null);

  // Prompt dialogs
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptAction, setPromptAction] = useState<{ taskId: string; type: "complete" | "fail" | "cancel" } | null>(null);
  const [promptValue, setPromptValue] = useState("");

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(currentPage));
      params.set("pageSize", String(PAGE_SIZE));
      if (activeTab === "manual") params.set("status", "MANUAL_REVIEW");
      const res = await apiRequest<{ items: TaskSummary[]; total: number }>(`tasks?${params}`);
      setTasks(res.items);
      setTotalItems(res.total);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, [currentPage, activeTab]);

  useEffect(() => { loadData(); }, [loadData]);

  const totalPages = Math.ceil(totalItems / PAGE_SIZE);

  const displayTasks = tasks.filter((task) => {
    if (activeTab === "retryable" && !["PENDING", "FAILED_RETRYABLE", "FAILED_FINAL", "MANUAL_REVIEW"].includes(task.status)) return false;
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return (
      task.id.toLowerCase().includes(q) ||
      task.type.toLowerCase().includes(q) ||
      task.status.toLowerCase().includes(q) ||
      task.order?.orderNo?.toLowerCase().includes(q) ||
      task.order?.userEmail?.toLowerCase().includes(q) ||
      task.familyGroup?.groupName?.toLowerCase().includes(q)
    );
  });

  async function handleRetry(taskId: string) {
    setActioning({ taskId, action: "retry" });
    try {
      await apiRequest(`tasks/${taskId}/retry`, { method: "POST" });
      toast.success("已重新入队");
      await loadData();
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setActioning(null); }
  }

  async function handlePromptSubmit() {
    if (!promptAction) return;
    const { taskId, type } = promptAction;
    setActioning({ taskId, action: type });
    try {
      if (type === "complete") {
        await apiRequest(`tasks/${taskId}/manual-complete`, { method: "POST", body: { resultMessage: promptValue } });
        toast.success("任务已标记为完成");
      } else if (type === "fail") {
        await apiRequest(`tasks/${taskId}/manual-fail`, { method: "POST", body: { reason: promptValue } });
        toast.success("任务已标记为失败");
      } else if (type === "cancel") {
        await apiRequest(`tasks/${taskId}/cancel`, { method: "POST", body: { reason: promptValue } });
        toast.success("任务已终止");
      }
      await loadData();
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally {
      setActioning(null);
      setPromptOpen(false);
      setPromptAction(null);
      setPromptValue("");
    }
  }

  function openPrompt(taskId: string, type: "complete" | "fail" | "cancel") {
    const defaults = { complete: "手动完成", fail: "手动标记失败", cancel: "操作员终止" };
    setPromptAction({ taskId, type });
    setPromptValue(defaults[type]);
    setPromptOpen(true);
  }

  function getPayloadEmails(task: TaskSummary) {
    try {
      if (!task.payload) return {};
      const p = JSON.parse(task.payload);
      return { target: p.targetMemberEmail, newUser: p.newUserEmail, user: p.userEmail };
    } catch { return {}; }
  }

  function renderPagination() {
    if (totalPages <= 1) return null;
    const pages: (number | "ellipsis")[] = [];
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) pages.push(i);
      else if (pages[pages.length - 1] !== "ellipsis") pages.push("ellipsis");
    }
    return (
      <Pagination className="mt-4">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} className={currentPage <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"} />
          </PaginationItem>
          {pages.map((p, idx) => p === "ellipsis" ? (
            <PaginationItem key={`e-${idx}`}><PaginationEllipsis /></PaginationItem>
          ) : (
            <PaginationItem key={p}>
              <PaginationLink isActive={p === currentPage} onClick={() => setCurrentPage(p)} className="cursor-pointer">{p}</PaginationLink>
            </PaginationItem>
          ))}
          <PaginationItem>
            <PaginationNext onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} className={currentPage >= totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"} />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>自动化任务</CardTitle>
              <CardDescription>
                共 {totalItems} 条{totalPages > 0 && ` · 第 ${currentPage}/${totalPages} 页`}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Input placeholder="搜索邮箱 / 任务号 / 类型…" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-64" />
              <Button variant="outline" size="sm" onClick={loadData} disabled={isLoading}>
                <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </div>
          <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v as typeof activeTab); setCurrentPage(1); }} className="mt-2">
            <TabsList>
              <TabsTrigger value="all">全部任务</TabsTrigger>
              <TabsTrigger value="manual">人工处理</TabsTrigger>
              <TabsTrigger value="retryable">可重试</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
          ) : displayTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <p className="text-lg">没有匹配的任务</p>
            </div>
          ) : (
            <>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[25%]">任务</TableHead>
                      <TableHead className="w-20">状态</TableHead>
                      <TableHead className="w-[18%]">关联对象</TableHead>
                      <TableHead className="w-[28%]">错误</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {displayTasks.map((task) => {
                      const isActioning = actioning?.taskId === task.id;
                      const emails = getPayloadEmails(task);
                      const displayEmail = emails.user || emails.target || task.order?.userEmail;
                      return (
                        <TableRow key={task.id}>
                          <TableCell>
                            <div className="font-semibold text-sm">{task.type}</div>
                            {displayEmail && (
                              <div className="text-xs break-all">
                                {displayEmail}
                                {emails.newUser && emails.target && <span className="text-muted-foreground"> → {emails.newUser}</span>}
                              </div>
                            )}
                            <div className="font-mono text-xs text-muted-foreground">
                              {task.id.slice(0, 12)} · retry {task.retryCount}/{task.maxRetryCount}
                            </div>
                            <TaskTimer task={task} />
                          </TableCell>
                          <TableCell>
                            <Badge variant={statusVariant(isActioning ? "RUNNING" : task.status)} className="text-xs">
                              {isActioning ? "..." : task.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">
                            {task.order?.orderNo && <div><span className="text-muted-foreground">订单：</span>{task.order.orderNo}</div>}
                            {task.familyGroup?.groupName && <div><span className="text-muted-foreground">家庭组：</span>{task.familyGroup.groupName}</div>}
                            {task.account?.name && <div><span className="text-muted-foreground">母号：</span>{task.account.name}</div>}
                            {!task.order?.orderNo && !task.familyGroup?.groupName && !task.account?.name && <span className="text-muted-foreground">-</span>}
                          </TableCell>
                          <TableCell>
                            <Collapsible>
                              <div className="text-xs font-medium">{task.lastErrorCode ?? "-"}</div>
                              {task.lastErrorMessage && (
                                <>
                                  <p className="text-xs text-muted-foreground line-clamp-2 break-words">{task.lastErrorMessage}</p>
                                  {task.lastErrorMessage.length > 60 && (
                                    <CollapsibleTrigger render={<Button variant="link" size="sm" className="h-auto p-0 text-xs" />}>
                                      <ChevronDown className="h-3 w-3 mr-1" />展开
                                    </CollapsibleTrigger>
                                  )}
                                  <CollapsibleContent>
                                    <p className="text-xs text-muted-foreground break-words mt-1">{task.lastErrorMessage}</p>
                                  </CollapsibleContent>
                                </>
                              )}
                            </Collapsible>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1 flex-wrap">
                              {canRetryTask(role, task.status) && (
                                <Button variant="outline" size="sm" disabled={isActioning} onClick={() => void handleRetry(task.id)} className="h-7 text-xs gap-1">
                                  {isActioning && actioning?.action === "retry" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                                  重试
                                </Button>
                              )}
                              {canManualCompleteTask(role, task.status) && (
                                <Button variant="outline" size="sm" disabled={isActioning} onClick={() => openPrompt(task.id, "complete")} className="h-7 text-xs gap-1">
                                  <CheckCircle2 className="h-3 w-3" />完成
                                </Button>
                              )}
                              {canManualFailTask(role, task.status) && (
                                <Button variant="outline" size="sm" disabled={isActioning} onClick={() => openPrompt(task.id, "fail")} className="h-7 text-xs gap-1">
                                  <XCircle className="h-3 w-3" />失败
                                </Button>
                              )}
                              {canCancelTask(role, task.status) && (
                                <Button variant="outline" size="sm" disabled={isActioning} onClick={() => openPrompt(task.id, "cancel")} className="h-7 text-xs gap-1 text-destructive">
                                  <Ban className="h-3 w-3" />终止
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              {renderPagination()}
            </>
          )}
        </CardContent>
      </Card>

      {/* Prompt dialog for manual actions */}
      <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {promptAction?.type === "complete" ? "手动完成" : promptAction?.type === "fail" ? "手动失败" : "终止任务"}
            </DialogTitle>
            <DialogDescription>
              {promptAction?.type === "complete" ? "填写完成说明" : promptAction?.type === "fail" ? "填写失败原因" : "填写终止原因"}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label>说明</Label>
            <InputField value={promptValue} onChange={(e) => setPromptValue(e.target.value)} className="mt-2" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPromptOpen(false)}>取消</Button>
            <Button onClick={() => void handlePromptSubmit()}>确认</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
