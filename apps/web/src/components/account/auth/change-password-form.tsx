"use client";

import { useState } from "react";
import { AccountButton, AccountInput } from "@/components/account/account-ui";
import { userApi } from "@/lib/account/user-api";
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
    <form onSubmit={handleSubmit} className="account-form-stack account-form-stack--narrow">
      <AccountInput
          label={t.form.currentPasswordLabel}
          type="password"
          autoComplete="current-password"
          placeholder={t.form.currentPasswordPlaceholder}
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          disabled={loading}
        />

      <AccountInput
          label={t.form.newPasswordLabel}
          type="password"
          autoComplete="new-password"
          placeholder={t.form.newPasswordPlaceholder}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          minLength={8}
          disabled={loading}
        />

      {error && <p className="account-form-error">{error}</p>}
      {success && (
        <p className="account-form-success">
          {t.settings.changePwdSuccess}
        </p>
      )}

      <AccountButton type="submit" disabled={loading}>
        {loading ? t.form.saving : t.actions.changePassword}
      </AccountButton>
    </form>
  );
}
