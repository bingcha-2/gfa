"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { registerUser } from "@/lib/user-api";
import { useDict } from "@/lib/i18n/client";

export function RegisterForm() {
  const router = useRouter();
  const dict = useDict();
  const t = dict.portalApp;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [referralCode, setReferralCode] = useState("");
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
        referralCode || undefined
      );
      router.push("/app");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.registerFailed);
    } finally {
      setLoading(false);
    }
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

      <Field>
        <FieldLabel>{t.form.displayNameLabel}</FieldLabel>
        <Input
          type="text"
          autoComplete="name"
          placeholder={t.form.displayNamePlaceholder}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          disabled={loading}
        />
      </Field>

      <Field>
        <FieldLabel>{t.form.passwordLabel}</FieldLabel>
        <Input
          type="password"
          autoComplete="new-password"
          placeholder={t.form.newPasswordPlaceholder}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          disabled={loading}
        />
      </Field>

      <Field>
        <FieldLabel>{t.form.referralCodeLabel}</FieldLabel>
        <Input
          type="text"
          placeholder={t.form.referralCodePlaceholder}
          value={referralCode}
          onChange={(e) => setReferralCode(e.target.value)}
          disabled={loading}
        />
      </Field>

      {error && <FieldError>{error}</FieldError>}

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? t.form.registering : t.actions.register}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        {t.form.haveAccount}{" "}
        <Link href="/app/login" className="hover:text-foreground transition-colors underline-offset-4 hover:underline">
          {t.actions.login}
        </Link>
      </p>
    </form>
  );
}
