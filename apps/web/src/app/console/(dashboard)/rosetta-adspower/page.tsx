"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { PlayIcon, SquareIcon } from "lucide-react";

type Credential = {
  email: string;
  password: string;
  recoveryEmail?: string;
  totpSecret?: string;
  phones?: { phoneNumber: string; smsUrl: string }[];
};

type AccountStatus = {
  email: string;
  status: "pending" | "running" | "success" | "failed";
  message?: string;
  error?: string;
};

type BatchProgress = {
  ok?: boolean;
  batchId?: string;
  status?: "running" | "completed" | "failed";
  total: number;
  completed?: number;
  failed?: number;
  done?: boolean;
  items: AccountStatus[];
};

function parseCredentialLine(line: string): Credential | null {
  if (!line || !line.trim()) return null;

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

  if (!emailRegex.test(email)) return null;
  if (!password) return null;

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

  let phones: { phoneNumber: string; smsUrl: string }[] | undefined;
  if (phonePart) {
    const phoneParts = phonePart
      .split(/\|/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (phoneParts.length >= 2) {
      const phoneNumber = phoneParts[0];
      const smsUrl = phoneParts.slice(1).join("|");
      phones = [{ phoneNumber, smsUrl }];
    }
  }

  return { email, password, recoveryEmail, totpSecret, phones };
}

function statusBadgeVariant(
  status: string
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "success":
      return "default";
    case "failed":
      return "destructive";
    case "running":
      return "outline";
    default:
      return "secondary";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "success":
      return "成功";
    case "failed":
      return "失败";
    case "running":
      return "进行中";
    case "pending":
      return "排队中";
    default:
      return status;
  }
}

export default function RosettaAdspowerPage() {
  const [text, setText] = useState("");
  const [importing, setImporting] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const pollStatus = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(
          `/api/rosetta/adspower-import-status?batchId=${id}`
        );
        if (!res.ok) return;
        const data: BatchProgress = await res.json();
        if (!data.ok) return;
        setProgress(data);
        if (data.done || data.status === "completed" || data.status === "failed") {
          stopPolling();
          setImporting(false);
          const successCount = data.items.filter(
            (i) => i.status === "success"
          ).length;
          const failedCount = data.items.filter(
            (i) => i.status === "failed"
          ).length;
          toast.success(
            `批量录入完成：${successCount} 成功 / ${failedCount} 失败`
          );
        }
      } catch {
        // ignore polling errors
      }
    },
    [stopPolling]
  );

  const startPolling = useCallback(
    (id: string) => {
      stopPolling();
      pollTimerRef.current = setInterval(() => pollStatus(id), 3000);
    },
    [stopPolling, pollStatus]
  );

  useEffect(() => {
    async function loadHistory() {
      try {
        const res = await fetch("/api/rosetta/adspower-import-history");
        if (!res.ok) return;
        const data = await res.json();
        if (data?.ok && data.batchId && data.total > 0) {
          setBatchId(data.batchId);
          setProgress(data);
          if (
            data.status === "running" ||
            (!data.done && data.items?.some((i: AccountStatus) => i.status === "running" || i.status === "pending"))
          ) {
            setImporting(true);
            startPolling(data.batchId);
          }
        }
      } catch {
        // ignore
      }
    }
    loadHistory();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  const handleImport = async () => {
    const lines = text.split(/\r?\n/);
    const credentials = lines.map(parseCredentialLine).filter(Boolean) as Credential[];
    if (!credentials.length) {
      toast.error("请粘贴至少一个有效账号凭证");
      return;
    }

    setImporting(true);
    try {
      const res = await fetch("/api/rosetta/adspower-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentials }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error || "提交失败");

      setBatchId(result.batchId);
      toast.success(`已提交 ${credentials.length} 个账号，开始自动录入`);
      setText("");

      setProgress({
        total: credentials.length,
        completed: 0,
        failed: 0,
        done: false,
        items: credentials.map((c) => ({
          email: c.email,
          status: "pending",
          message: "排队中",
        })),
      });

      startPolling(result.batchId);
    } catch (err) {
      toast.error("提交失败: " + (err instanceof Error ? err.message : String(err)));
      setImporting(false);
    }
  };

  const overallStatus: "ready" | "running" | "done" = importing
    ? "running"
    : progress?.done || progress?.status === "completed" || progress?.status === "failed"
      ? "done"
      : "ready";

  const successCount = progress?.items.filter((i) => i.status === "success").length ?? 0;
  const failedCount = progress?.items.filter((i) => i.status === "failed").length ?? 0;
  const total = progress?.total ?? 0;
  const completedCount = successCount + failedCount;
  const percent = total > 0 ? Math.round((completedCount / total) * 100) : 0;

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">AdsPower 批量自动录入</h1>
          <p className="text-sm text-muted-foreground">
            通过 AdsPower
            指纹浏览器自动完成 Google 登录 + OAuth
            授权，直接录入账号池。支持多浏览器并行。
          </p>
        </div>
        <Badge
          variant={
            overallStatus === "running"
              ? "default"
              : overallStatus === "done"
                ? "secondary"
                : "outline"
          }
        >
          {overallStatus === "running"
            ? "录入中"
            : overallStatus === "done"
              ? "完成"
              : "就绪"}
        </Badge>
      </div>

      {/* Batch Input */}
      <Card>
        <CardHeader>
          <CardTitle>批量导入</CardTitle>
          <CardDescription>
            格式：<code className="text-xs">邮箱|密码|恢复邮箱|TOTP</code>
            （用 <code className="text-xs">|</code> 或{" "}
            <code className="text-xs">----</code>{" "}
            分隔）。如需手机验证，在账号行后追加{" "}
            <code className="text-xs">------手机号|短信接收URL</code>。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Textarea
            className="min-h-[160px] font-mono text-sm"
            placeholder={
              "批量粘贴账号凭证，每行一个：\n邮箱|密码|恢复邮箱|TOTP密钥\n邮箱|密码（恢复邮箱和TOTP可省略）"
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              将使用所有已配置的 AdsPower Profile 并行处理
            </p>
            <Button
              onClick={handleImport}
              disabled={!text.trim() || importing}
            >
              {importing ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <PlayIcon data-icon="inline-start" />
              )}
              一键录入
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Progress */}
      {progress && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>录入进度</CardTitle>
              {importing && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    stopPolling();
                    setImporting(false);
                  }}
                >
                  <SquareIcon data-icon="inline-start" />
                  停止轮询
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {completedCount}/{total} 完成，{failedCount} 失败
              </span>
              <span className="font-medium">{percent}%</span>
            </div>
            <Progress value={percent} />
            <Separator />
            <ScrollArea className="max-h-[500px]">
              <div className="flex flex-col gap-2">
                {progress.items.map((item, idx) => (
                  <div
                    key={`${item.email}-${idx}`}
                    className="flex items-center justify-between rounded-md border px-3 py-2"
                  >
                    <span className="truncate font-mono text-sm">
                      {item.email}
                    </span>
                    <div className="flex items-center gap-2">
                      {item.status === "running" && <Spinner className="size-3.5" />}
                      <Badge variant={statusBadgeVariant(item.status)}>
                        {statusLabel(item.status)}
                      </Badge>
                    </div>
                  </div>
                ))}
                {progress.items
                  .filter((i) => i.status === "failed" && (i.error || i.message))
                  .map((item, idx) => (
                    <p
                      key={`err-${item.email}-${idx}`}
                      className="pl-3 text-xs text-destructive"
                    >
                      {item.email}: {item.error || item.message}
                    </p>
                  ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
