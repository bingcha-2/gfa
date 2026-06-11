"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { loginUser } from "@/lib/user-api";
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
      router.push("/app");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.loginFailed);
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
        <FieldLabel>{t.form.passwordLabel}</FieldLabel>
        <Input
          type="password"
          autoComplete="current-password"
          placeholder={t.form.passwordPlaceholder}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          disabled={loading}
        />
      </Field>

      {error && (
        <FieldError>
          {error}
        </FieldError>
      )}

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? t.form.loggingIn : t.actions.login}
      </Button>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <Link
          href="/app/forgot"
          className="hover:text-foreground transition-colors"
        >
          {t.actions.forgotPassword}
        </Link>
        <Link
          href="/app/register"
          className="hover:text-foreground transition-colors"
        >
          {t.actions.register}
        </Link>
      </div>
    </form>
  );
}
