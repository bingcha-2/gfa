"use client";

import { useState } from "react";
import Link from "next/link";

import { AccountButton, AccountInput } from "@/components/account/account-ui";
import { forgotPassword } from "@/lib/account/user-api";
import { useDict } from "@/lib/i18n/client";

export function ForgotForm() {
  const dict = useDict();
  const t = dict.portalApp;

  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await forgotPassword(email);
    } catch {
      // Always show success — no email enumeration
    } finally {
      setLoading(false);
      setSent(true);
    }
  }

  if (sent) {
    return (
      <div className="account-auth-state">
        <p>{t.form.forgotSent}</p>
        <Link
          href="/account/login"
          className="account-link"
        >
          {t.actions.backToLogin}
        </Link>
      </div>
    );
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

      <AccountButton type="submit" disabled={loading}>
        {loading ? t.form.sending : t.actions.sendResetLink}
      </AccountButton>

      <p className="account-login-links">
        <Link
          href="/account/login"
          className="account-link"
        >
          {t.actions.backToLogin}
        </Link>
      </p>
    </form>
  );
}
