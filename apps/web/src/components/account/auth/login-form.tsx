"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { AccountButton, AccountInput } from "@/components/account/account-ui";
import { loginUser } from "@/lib/account/user-api";
import { useDict } from "@/lib/i18n/client";

export function LoginForm() {
  const router = useRouter();
  const dict = useDict();
  const t = dict.portalApp;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await loginUser(email, password);
      router.push("/account");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.loginFailed);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="account-login-form">
      <AccountInput
        label={t.form.emailLabel}
        type="email"
        autoComplete="email"
        placeholder={t.form.emailPlaceholder}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        disabled={loading}
      />

      <AccountInput
        label={t.form.passwordLabel}
        type="password"
        autoComplete="current-password"
        placeholder={t.form.passwordPlaceholder}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        disabled={loading}
      />

      {error && (
        <p className="account-form-error" role="alert">
          {error}
        </p>
      )}

      <AccountButton type="submit" disabled={loading}>
        {loading ? t.form.loggingIn : t.actions.login}
      </AccountButton>

      <div className="account-login-links">
        <Link href="/account/forgot" className="account-link">
          {t.actions.forgotPassword}
        </Link>
        <Link href="/account/register" className="account-link">
          {t.actions.register}
        </Link>
      </div>
    </form>
  );
}
