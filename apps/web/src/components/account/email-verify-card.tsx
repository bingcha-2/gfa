"use client";

import { useState } from "react";
import { BadgeCheckIcon, MailWarningIcon } from "lucide-react";

import { useAccount } from "@/components/account/account-provider";
import { AccountButton } from "@/components/account/account-ui";
import { userApi } from "@/lib/account/user-api";
import { useDict } from "@/lib/i18n/client";

/**
 * 邮箱验证卡:已验证显示徽章;未验证给一个「发送验证邮件」按钮(打到
 * POST auth/request-verify-email,已登录用户重发)。下单 gate 依赖 emailVerified,
 * 这里是用户自助验证入口 —— 同时也是忘记密码找回的前提。
 */
export function EmailVerifyCard() {
  const dict = useDict();
  const s = dict.portalApp.settings;
  const { customer } = useAccount();

  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (customer.emailVerified) {
    return (
      <p className="account-form-success" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <BadgeCheckIcon className="size-4" />
        {s.emailVerified} · {customer.email}
      </p>
    );
  }

  async function handleSend() {
    setError(null);
    setLoading(true);
    try {
      await userApi("auth/request-verify-email", { method: "POST" });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : s.emailVerifyFailed);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="account-form-stack account-form-stack--narrow">
      <p style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <MailWarningIcon className="size-4" />
        {s.emailUnverified} · {customer.email}
      </p>

      {error && <p className="account-form-error">{error}</p>}
      {sent && <p className="account-form-success">{s.emailVerifySent}</p>}

      <AccountButton type="button" onClick={handleSend} disabled={loading || sent}>
        {loading ? s.emailVerifySending : s.emailVerifySend}
      </AccountButton>
    </div>
  );
}
