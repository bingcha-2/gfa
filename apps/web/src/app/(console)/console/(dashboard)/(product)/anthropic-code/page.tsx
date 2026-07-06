"use client";

import { useMemo, useState } from "react";
import { ClipboardIcon, KeyRoundIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { consoleApiPath } from "@/lib/console/client-api";

type CodeResult = {
  ok: boolean;
  code?: string;
  subject?: string;
  date?: string;
  source?: string;
  adspowerProfileId?: string;
  startedProfile?: boolean;
  error?: string;
};

const DEFAULT_PROFILE_ID = "k1e8c364";

function formatDate(value?: string) {
  if (!value) return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time).toLocaleString();
}

export default function AnthropicCodePage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [adspowerProfileId, setAdspowerProfileId] = useState(DEFAULT_PROFILE_ID);
  const [waitSeconds, setWaitSeconds] = useState("120");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CodeResult | null>(null);

  const disabled = loading || !email.trim() || !password.trim() || !adspowerProfileId.trim();
  const mailDate = useMemo(() => formatDate(result?.date), [result?.date]);

  async function handleSubmit() {
    if (disabled) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(consoleApiPath("rosetta/anthropic-verification-code"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
          adspowerProfileId: adspowerProfileId.trim(),
          waitMs: Math.max(15, Number(waitSeconds) || 120) * 1000,
          closeCodeTab: true,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data);
      toast.success("验证码已获取");
    } catch (error) {
      const message = error instanceof Error ? error.message : "获取失败";
      setResult({ ok: false, error: message });
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  async function copyCode() {
    const code = result?.code || "";
    if (!code) return;
    await navigator.clipboard.writeText(code);
    toast.success("验证码已复制");
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Claude 验证码</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            邮箱取 Claude secure link，指定 AdsPower 浏览器打开链接并返回验证码。
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRoundIcon className="size-4" />
            获取验证码
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[minmax(220px,1.2fr)_minmax(180px,1fr)]">
            <Field>
              <FieldLabel>邮箱</FieldLabel>
              <Input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="mail-user@example.com"
                autoComplete="off"
                disabled={loading}
              />
            </Field>
            <Field>
              <FieldLabel>邮箱密码</FieldLabel>
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="mail.com 密码"
                autoComplete="off"
                disabled={loading}
              />
            </Field>
          </div>

          <div className="grid gap-3 md:grid-cols-[minmax(180px,1fr)_140px_auto] md:items-end">
            <Field>
              <FieldLabel>AdsPower 浏览器</FieldLabel>
              <Input
                value={adspowerProfileId}
                onChange={(event) => setAdspowerProfileId(event.target.value)}
                placeholder={DEFAULT_PROFILE_ID}
                autoComplete="off"
                disabled={loading}
              />
            </Field>
            <Field>
              <FieldLabel>等待秒数</FieldLabel>
              <Input
                type="number"
                min={15}
                max={300}
                value={waitSeconds}
                onChange={(event) => setWaitSeconds(event.target.value)}
                disabled={loading}
              />
            </Field>
            <Button onClick={handleSubmit} disabled={disabled} className="md:mb-0">
              {loading ? <Spinner data-icon className="size-4" /> : <RefreshCwIcon data-icon className="size-4" />}
              获取验证码
            </Button>
          </div>
        </CardContent>
      </Card>

      {result ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">结果</CardTitle>
          </CardHeader>
          <CardContent>
            {result.ok && result.code ? (
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="space-y-2">
                  <div className="font-mono text-4xl font-semibold tracking-normal tabular-nums">{result.code}</div>
                  <div className="space-y-1 text-sm text-muted-foreground">
                    <div>浏览器: {result.adspowerProfileId || adspowerProfileId}</div>
                    {mailDate ? <div>邮件时间: {mailDate}</div> : null}
                    {result.subject ? <div>邮件主题: {result.subject}</div> : null}
                    <div>来源: {result.source || "mail-password"}</div>
                  </div>
                </div>
                <Button variant="outline" onClick={copyCode}>
                  <ClipboardIcon className="size-4" />
                  复制验证码
                </Button>
              </div>
            ) : (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {result.error || "获取失败"}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
