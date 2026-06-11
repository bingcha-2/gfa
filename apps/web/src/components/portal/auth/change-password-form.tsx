"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { userApi } from "@/lib/user-api";
import { useDict } from "@/lib/i18n/client";

export function ChangePasswordForm() {
  const dict = useDict();
  const t = dict.portalApp;

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setLoading(true);
    try {
      await userApi("auth/change-password", {
        method: "POST",
        body: { currentPassword, newPassword },
      });
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t.errors.changePwdFailed
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-sm">
      <Field>
        <FieldLabel>{t.form.currentPasswordLabel}</FieldLabel>
        <Input
          type="password"
          autoComplete="current-password"
          placeholder={t.form.currentPasswordPlaceholder}
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          disabled={loading}
        />
      </Field>

      <Field>
        <FieldLabel>{t.form.newPasswordLabel}</FieldLabel>
        <Input
          type="password"
          autoComplete="new-password"
          placeholder={t.form.newPasswordPlaceholder}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          minLength={8}
          disabled={loading}
        />
      </Field>

      {error && <FieldError>{error}</FieldError>}
      {success && (
        <p className="text-sm text-green-600 dark:text-green-400">
          {t.settings.changePwdSuccess}
        </p>
      )}

      <Button type="submit" disabled={loading}>
        {loading ? t.form.saving : t.actions.changePassword}
      </Button>
    </form>
  );
}
