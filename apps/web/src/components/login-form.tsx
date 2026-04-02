"use client";

import Link from "next/link";
import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";

import { getErrorMessage } from "../lib/client-api";

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

    if (Array.isArray(message)) {
      return message.join(", ");
    }

    if (typeof message === "string") {
      return message;
    }
  }

  return fallback;
}

export function LoginForm() {
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
          "content-type": "application/json"
        },
        body: JSON.stringify({ email: normalizedEmail, password }),
        cache: "no-store"
      });

      const raw = await response.text();
      const payload = safeParseJson(raw);

      if (!response.ok) {
        throw new Error(getLoginErrorMessage(payload, raw || "Login failed"));
      }

      startTransition(() => {
        const prefix = (process.env.NEXT_PUBLIC_ADMIN_PATH_PREFIX ?? "console").replace(/^\/|\/$/g, "") || "console";
        router.push(`/${prefix}`);
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
    <section className="form-card">
      <div className="panel-stack">
        <div>
          <p className="label" suppressHydrationWarning>Credentials</p>
          <h2 className="public-panel-title" suppressHydrationWarning>后台登录</h2>
          <p className="muted" suppressHydrationWarning>输入运营账号和密码。</p>
        </div>

        <form className="field-grid" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="login-email">邮箱</label>
            <input
              id="login-email"
              autoComplete="email"
              inputMode="email"
              placeholder="ops@example.com"
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value.trimStart())}
            />
          </div>

          <div className="field">
            <label htmlFor="login-password">密码</label>
            <input
              id="login-password"
              autoComplete="current-password"
              placeholder="请输入密码"
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          <div className="field-actions">
            <button className="button" disabled={isPending} type="submit">
              {isPending ? "登录中..." : "进入控制台"}
            </button>
            <Link className="button secondary" href="/">
              返回首页
            </Link>
          </div>
        </form>

        {error ? <div className="notice error">{error}</div> : null}
      </div>
    </section>
  );
}
