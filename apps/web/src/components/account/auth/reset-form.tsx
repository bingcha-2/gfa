"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AccountButton, AccountInput } from "@/components/account/account-ui";
import { resetPassword } from "@/lib/account/user-api";
import { useDict } from "@/lib/i18n/client";

export function ResetForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dict = useDict();
  const t = dict.portalApp;

  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await resetPassword(token, password);
      router.push("/account/login");
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.resetFailed);
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <p className="account-auth-state">
        {t.errors.invalidResetToken}
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="account-login-form">
      <AccountInput
          label={t.form.newPasswordLabel}
          type="password"
          autoComplete="new-password"
          placeholder={t.form.newPasswordPlaceholder}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          disabled={loading}
        />

      {error && <p className="account-form-error">{error}</p>}

      <AccountButton type="submit" disabled={loading}>
        {loading ? t.form.resetting : t.actions.resetPassword}
      </AccountButton>
    </form>
  );
}
