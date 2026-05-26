"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  RefreshCw,
  ShieldCheck,
  RotateCcw,
  Clock,
  LockOpen,
} from "lucide-react";

import { apiRequest, getErrorMessage } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type ParsedAccount = {
  email: string;
  password: string;
  recoveryEmail?: string;
  totpSecret?: string;
  phone?: string;
  smsUrl?: string;
};

type UnblockTask = {
  id: string;
  email: string;
  status: string;
  source?: string;
  usedPhone?: string;
  lastErrorMessage?: string;
  lastErrorCode?: string;
  createdAt?: string;
};

type Phase2Task = {
  email: string;
  password?: string;
  recoveryEmail?: string;
  totpSecret?: string;
  usedPhone?: string;
  appealAt?: string;
};

type StatusResponse = {
  ok?: boolean;
  tasks: UnblockTask[];
  phase2: Phase2Task[];
};

function parseCredentialLine(line: string): ParsedAccount | null {
  if (!line?.trim()) return null;

  const mainAndPhone = line.trim().split(/------/);
  const mainPart = (mainAndPhone[0] || "").trim();
  const phonePart = (mainAndPhone[1] || "").trim();

  const parts = mainPart
    .split(/\||\t/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const totpRegex = /^[a-z2-7\s\-=]{16,}$/i;
  const isTotpLike = (s: string) =>
    /2fa\.live\/tok\//i.test(s) || (totpRegex.test(s) && !/^\d{4}$/.test(s));

  const email = parts[0];
  const password = parts[1];

  if (!emailRegex.test(email) || !password) return null;

  let recoveryEmail: string | undefined;
  let totpSecret: string | undefined;

  for (let i = 2; i < parts.length; i++) {
    const p = parts[i];
    if (!recoveryEmail && emailRegex.test(p)) {
      recoveryEmail = p;
    } else if (!totpSecret && isTotpLike(p)) {
      totpSecret = p;
    }
  }

  let phone: string | undefined;
  let smsUrl: string | undefined;

  if (phonePart) {
    const phoneParts = phonePart
      .split(/\|/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (phoneParts.length >= 2) {
      phone = phoneParts[0];
      smsUrl = phoneParts.slice(1).join("|");
    }
  }

  return { email, password, recoveryEmail, totpSecret, phone, smsUrl };
}

function maskEmail(email: string) {
  const at = email.indexOf("@");
  if (at <= 2) return email;
  return email[0] + "***" + email.slice(at);
}

function formatDateTime(iso: string) {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

type OverallStatus = "idle" | "active" | "done";

function statusBadgeVariant(status: string) {
  switch (status) {
    case "PENDING":
      return "secondary" as const;
    case "RUNNING":
      return "default" as const;
    case "SUCCESS":
    case "UNBLOCKED":
      return "default" as const;
    case "FAILED_FINAL":
      return "destructive" as const;
    case "MANUAL_REVIEW":
      return "outline" as const;
    default:
      return "secondary" as const;
  }
}

function statusLabel(task: UnblockTask) {
  const src = task.source || "";
  switch (task.status) {
    case "SUCCESS":
    case "UNBLOCKED":
      return "已解封";
    case "FAILED_FINAL":
      return "失败";
    case "MANUAL_REVIEW":
      if (task.lastErrorCode === "PHONE_VERIFIED_APPEAL_REQUIRED")
        return "需手工申诉";
      return "需人工介入";
    case "RUNNING":
      return src.includes("phase2") ? "二次验证中" : "解封进行中";
    case "PENDING":
      return "排队中";
    default:
      return task.status;
  }
}

export default function RosettaCaptchaPage() {
  const [batchText, setBatchText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [tasks, setTasks] = useState<UnblockTask[]>([]);
  const [phase2, setPhase2] = useState<Phase2Task[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [phase2Email, setPhase2Email] = useState<string | null>(null);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const overallStatus: OverallStatus = (() => {
    const active = tasks.filter(
      (t) => !["SUCCESS", "FAILED_FINAL", "UNBLOCKED"].includes(t.status)
    );
    if (active.length > 0) return "active";
    if (tasks.length > 0) return "done";
    return "idle";
  })();

  const fetchTasks = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const data = await apiRequest<StatusResponse>(
        "rosetta/captcha-unblock/status"
      );
      setTasks(data.tasks || []);
      setPhase2(data.phase2 || []);
    } catch (err) {
      if (!silent) toast.error(getErrorMessage(err));
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks(true);
  }, [fetchTasks]);

  useEffect(() => {
    const hasRunning = tasks.some(
      (t) => t.status === "RUNNING" || t.status === "PENDING"
    );
    if (hasRunning && !autoRefreshRef.current) {
      autoRefreshRef.current = setInterval(() => fetchTasks(true), 10_000);
    } else if (!hasRunning && autoRefreshRef.current) {
      clearInterval(autoRefreshRef.current);
      autoRefreshRef.current = null;
    }
    return () => {
      if (autoRefreshRef.current) {
        clearInterval(autoRefreshRef.current);
        autoRefreshRef.current = null;
      }
    };
  }, [tasks, fetchTasks]);

  const handleStartPhase1 = async () => {
    const raw = batchText.trim();
    if (!raw) {
      toast.warning("请粘贴待解封的账号凭证");
      return;
    }

    const lines = raw.split(/\n/).filter((l) => l.trim());
    const accounts = lines
      .map((l) => parseCredentialLine(l))
      .filter(Boolean) as ParsedAccount[];

    if (!accounts.length) {
      toast.error("未解析到有效账号");
      return;
    }

    setSubmitting(true);
    try {
      for (const acc of accounts) {
        try {
          await apiRequest("rosetta/captcha-unblock", {
            method: "POST",
            body: {
              accounts: [
                {
                  email: acc.email,
                  password: acc.password,
                  recoveryEmail: acc.recoveryEmail || "",
                  totpSecret: acc.totpSecret || "",
                  phone: acc.phone,
                  smsUrl: acc.smsUrl,
                },
              ],
              phase: "first",
            },
          });
          toast.success(`${acc.email} 解封任务已创建`);
        } catch (err) {
          toast.error(`${acc.email} 创建失败: ${getErrorMessage(err)}`);
        }
      }
      setBatchText("");
      await fetchTasks();
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetry = async (taskId: string) => {
    setRetryingId(taskId);
    try {
      await apiRequest("rosetta/captcha-unblock/retry", {
        method: "POST",
        body: { taskId },
      });
      toast.success("已重新提交");
      await fetchTasks();
    } catch (err) {
      toast.error("重试失败: " + getErrorMessage(err));
    } finally {
      setRetryingId(null);
    }
  };

  const handlePhase2 = async (task: Phase2Task) => {
    setPhase2Email(task.email);
    try {
      await apiRequest("rosetta/captcha-unblock", {
        method: "POST",
        body: {
          accounts: [
            {
              email: task.email,
              password: task.password || "",
              recoveryEmail: task.recoveryEmail || "",
              totpSecret: task.totpSecret || "",
            },
          ],
          phase: "second",
        },
      });
      toast.success(`${task.email} 二次验证任务已创建`);
      await fetchTasks();
    } catch (err) {
      toast.error(`${task.email} 创建失败: ${getErrorMessage(err)}`);
    } finally {
      setPhase2Email(null);
    }
  };

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold">人机解封</h1>
              <Badge
                variant={
                  overallStatus === "active"
                    ? "default"
                    : overallStatus === "done"
                      ? "secondary"
                      : "outline"
                }
              >
                {overallStatus === "active"
                  ? `${tasks.filter((t) => !["SUCCESS", "FAILED_FINAL", "UNBLOCKED"].includes(t.status)).length} 进行中`
                  : overallStatus === "done"
                    ? "完成"
                    : "就绪"}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground max-w-2xl">
              解封遭遇人机挑战的 Google 账号，分两阶段进行：① 手工通过人机 +
              自动手机验证 + 手工申诉 → ② 12小时后二次验证完成解封。
            </p>
          </div>
        </div>

        {/* Batch Input */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">批量输入</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Textarea
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              placeholder={
                "批量粘贴待解封账号，每行一个：\n邮箱|密码|恢复邮箱|TOTP密钥\n若含手机号，下一行用 ------手机号|smsUrl"
              }
              className="min-h-[140px] font-mono text-xs"
            />
            <div className="flex items-center justify-between gap-4">
              <p className="text-xs text-muted-foreground">
                格式：
                <code className="rounded bg-muted px-1">
                  邮箱|密码|恢复邮箱|TOTP
                </code>
                （用{" "}
                <code className="rounded bg-muted px-1">|</code> 分隔，恢复邮箱和
                TOTP 可省略）。下一行可附
                <code className="rounded bg-muted px-1">------手机号|smsUrl</code>
              </p>
              <Button
                disabled={submitting || !batchText.trim()}
                onClick={handleStartPhase1}
              >
                {submitting ? (
                  <Spinner data-icon />
                ) : (
                  <LockOpen data-icon />
                )}
                开始解封（阶段一）
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Task List */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">解封任务</CardTitle>
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing}
              onClick={() => fetchTasks()}
            >
              {refreshing ? (
                <Spinner data-icon />
              ) : (
                <RefreshCw data-icon />
              )}
              刷新
            </Button>
          </CardHeader>
          <CardContent>
            {tasks.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ShieldCheck />
                  </EmptyMedia>
                  <EmptyTitle>暂无解封任务</EmptyTitle>
                  <EmptyDescription>
                    在上方粘贴账号凭证并点击「开始解封」创建任务
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-2">
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className="flex items-start justify-between gap-4 rounded-lg border p-3"
                  >
                    <div className="flex flex-col gap-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm truncate">
                          {maskEmail(task.email)}
                        </span>
                        <Badge variant={statusBadgeVariant(task.status)}>
                          {statusLabel(task)}
                        </Badge>
                        {task.usedPhone && (
                          <span className="text-xs text-muted-foreground">
                            📱 {maskEmail(task.usedPhone)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {task.createdAt && (
                          <span>{formatDateTime(task.createdAt)}</span>
                        )}
                      </div>
                      {task.lastErrorMessage && (
                        <Tooltip>
                          <TooltipTrigger
                            render={<p className="text-xs text-destructive truncate max-w-md cursor-default" />}
                          >
                            {task.lastErrorMessage.substring(0, 120)}
                          </TooltipTrigger>
                          <TooltipContent
                            side="bottom"
                            className="max-w-sm"
                          >
                            {task.lastErrorMessage}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                    <div className="shrink-0">
                      {task.status !== "RUNNING" &&
                        task.status !== "PENDING" && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={retryingId === task.id}
                            onClick={() => handleRetry(task.id)}
                          >
                            {retryingId === task.id ? (
                              <Spinner data-icon />
                            ) : (
                              <RotateCcw data-icon />
                            )}
                            重试
                          </Button>
                        )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Separator />

        {/* Phase 2 */}
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-1">
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="size-4" />
                待二次验证
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                申诉通过后（约12小时），点击下方按钮进行二次手机验证完成解封。
              </p>
            </div>
          </CardHeader>
          <CardContent>
            {phase2.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Clock />
                  </EmptyMedia>
                  <EmptyTitle>暂无待二次验证的账号</EmptyTitle>
                  <EmptyDescription>
                    完成阶段一后，等待12小时即可进行二次验证
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-2">
                {phase2.map((task) => {
                  const elapsed = task.appealAt
                    ? Math.round(
                        (Date.now() - new Date(task.appealAt).getTime()) /
                          3_600_000
                      )
                    : 0;
                  const ready = elapsed >= 12;

                  return (
                    <div
                      key={task.email}
                      className={`flex items-start justify-between gap-4 rounded-lg border p-3 ${
                        ready ? "border-green-500/40" : ""
                      }`}
                    >
                      <div className="flex flex-col gap-1 min-w-0">
                        <span className="font-mono text-sm">
                          {maskEmail(task.email)}
                        </span>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>
                            申诉时间:{" "}
                            {task.appealAt
                              ? formatDateTime(task.appealAt)
                              : "未知"}
                          </span>
                          <span>·</span>
                          <span>已过 {elapsed}h</span>
                          {ready ? (
                            <Badge
                              variant="default"
                              className="text-[10px] px-1.5 py-0"
                            >
                              可验证
                            </Badge>
                          ) : (
                            <Badge
                              variant="secondary"
                              className="text-[10px] px-1.5 py-0"
                            >
                              等待中
                            </Badge>
                          )}
                          {task.usedPhone && (
                            <span>📱 {maskEmail(task.usedPhone)}</span>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0">
                        <Button
                          variant={ready ? "default" : "outline"}
                          size="sm"
                          disabled={!ready || phase2Email === task.email}
                          onClick={() => handlePhase2(task)}
                        >
                          {phase2Email === task.email ? (
                            <Spinner data-icon />
                          ) : ready ? (
                            <LockOpen data-icon />
                          ) : (
                            <Clock data-icon />
                          )}
                          {ready ? "二次验证" : "等待12h"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}
