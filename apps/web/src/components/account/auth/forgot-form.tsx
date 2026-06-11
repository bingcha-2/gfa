"use client";

import { useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
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
      <div className="space-y-4 text-center">
        <p className="text-sm text-muted-foreground">{t.form.forgotSent}</p>
        <Link
          href="/account/login"
          className="text-sm text-accent hover:underline"
        >
          {t.actions.backToLogin}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field>
        <FieldLabel>{t.form.emailLabel}</FieldLabel>
        <Input
          type="email"
          autoComplete="email"
          placeholder={t.form.emailPlaceholder}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={loading}
        />
      </Field>

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? t.form.sending : t.actions.sendResetLink}
      </Button>

      <p className="text-center text-sm">
        <Link
          href="/account/login"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          {t.actions.backToLogin}
        </Link>
      </p>
    </form>
  );
}
