"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { AccountButton, AccountInput } from "@/components/account/account-ui";
import { registerUser } from "@/lib/account/user-api";
import { useDict } from "@/lib/i18n/client";

export function RegisterForm() {
  const router = useRouter();
  const dict = useDict();
  const t = dict.portalApp;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await registerUser(
        email,
        password,
        displayName || undefined,
        undefined
      );
      router.push("/account");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.registerFailed);
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
          label={t.form.displayNameLabel}
          type="text"
          autoComplete="name"
          placeholder={t.form.displayNamePlaceholder}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          disabled={loading}
        />

      <AccountInput
          label={t.form.passwordLabel}
          type="password"
          autoComplete="new-password"
          placeholder={t.form.newPasswordPlaceholder}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          disabled={loading}
        />

      {error && <p className="account-form-error">{error}</p>}

      <AccountButton type="submit" disabled={loading}>
        {loading ? t.form.registering : t.actions.register}
      </AccountButton>

      <p className="account-login-links">
        {t.form.haveAccount}{" "}
        <Link href="/account/login" className="account-link">
          {t.actions.login}
        </Link>
      </p>
    </form>
  );
}
