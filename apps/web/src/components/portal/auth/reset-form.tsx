"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { resetPassword } from "@/lib/user-api";
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
      router.push("/app/login");
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.resetFailed);
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <p className="text-center text-sm text-muted-foreground">
        {t.errors.invalidResetToken}
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field>
        <FieldLabel>{t.form.newPasswordLabel}</FieldLabel>
        <Input
          type="password"
          autoComplete="new-password"
          placeholder={t.form.newPasswordPlaceholder}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          disabled={loading}
        />
      </Field>

      {error && <FieldError>{error}</FieldError>}

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? t.form.resetting : t.actions.resetPassword}
      </Button>
    </form>
  );
}
