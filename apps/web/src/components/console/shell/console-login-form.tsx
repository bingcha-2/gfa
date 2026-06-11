"use client";

import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { getErrorMessage } from "@/lib/console/client-api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { CircleAlertIcon } from "lucide-react";

function safeParseJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getLoginErrorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (Array.isArray(message)) return message.join(", ");
    if (typeof message === "string") return message;
  }
  return fallback;
}

export function ConsoleLoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsPending(true);
    setError(null);

    const normalizedEmail = email.trim().toLowerCase();

    try {
      const response = await fetch("/api/session/login", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: normalizedEmail, password }),
        cache: "no-store",
      });

      const raw = await response.text();
      const payload = safeParseJson(raw);

      if (!response.ok) {
        throw new Error(getLoginErrorMessage(payload, raw || "Login failed"));
      }

      startTransition(() => {
        const prefix =
          (
            process.env.NEXT_PUBLIC_ADMIN_PATH_PREFIX ?? "console"
          ).replace(/^\/|\/$/g, "") || "console";
        const next = new URLSearchParams(window.location.search).get("next");
        router.push(next && next.startsWith("/") && !next.startsWith("//") ? next : `/${prefix}`);
        router.refresh();
      });
    } catch (loginError) {
      setError(getErrorMessage(loginError));
      setIsPending(false);
      return;
    }

    setIsPending(false);
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted p-6 md:p-10">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">运营控制台</CardTitle>
            <CardDescription>输入运营账号和密码登录</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="login-email">邮箱</FieldLabel>
                  <Input
                    id="login-email"
                    type="email"
                    placeholder="ops@example.com"
                    required
                    autoComplete="email"
                    inputMode="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value.trimStart())}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="login-password">密码</FieldLabel>
                  <Input
                    id="login-password"
                    type="password"
                    placeholder="请输入密码"
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>

                {error && (
                  <Alert variant="destructive">
                    <CircleAlertIcon />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <Field>
                  <Button type="submit" className="w-full" disabled={isPending}>
                    {isPending && <Spinner />}
                    {isPending ? "登录中…" : "进入控制台"}
                  </Button>
                </Field>

                <Field className="text-center">
                  <Button variant="link" nativeButton={false} render={<Link href="/" />}>
                    返回首页
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
