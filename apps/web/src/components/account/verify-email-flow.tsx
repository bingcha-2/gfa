"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2Icon, XCircleIcon } from "lucide-react";

import { AccountSkeleton } from "@/components/account/account-ui";
import { verifyEmailToken } from "@/lib/account/user-api";
import { useDict } from "@/lib/i18n/client";

type ViewState = "verifying" | "success" | "invalid" | "missing";

/**
 * One-shot email verification. The POST is guarded by a ref so StrictMode's
 * mount→cleanup→mount double-effect cannot fire it twice.
 */
export function VerifyEmailFlow({ token }: { token: string | null }) {
  const dict = useDict();
  const t = dict.portalApp.verifyEmail;

  const fired = useRef(false);
  const mountedRef = useRef(true);
  const [state, setState] = useState<ViewState>(
    token ? "verifying" : "missing"
  );

  // Track mount status across StrictMode remounts (cleanup → remount restores true).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!token || fired.current) return;
    fired.current = true; // single-fire guard — StrictMode cannot double-POST

    void verifyEmailToken(token).then((result) => {
      if (!mountedRef.current) return;
      setState(result.ok ? "success" : "invalid");
    });
  }, [token]);

  if (state === "missing") {
    return (
      <div className="account-auth-state">
        <XCircleIcon />
        <p>{t.missingToken}</p>
        <Link
          href="/account"
          className="account-link"
        >
          {t.goPortal}
        </Link>
      </div>
    );
  }

  if (state === "verifying") {
    return (
      <div className="account-auth-state">
        <AccountSkeleton className="account-skeleton--avatar" />
        <p>{t.verifying}</p>
      </div>
    );
  }

  if (state === "success") {
    return (
      <div className="account-auth-state" data-tone="success">
        <CheckCircle2Icon />
        <div>{t.successTitle}</div>
        <p>{t.successDesc}</p>
        <Link
          href="/account"
          className="account-link"
        >
          {t.goPortal}
        </Link>
      </div>
    );
  }

  return (
    <div className="account-auth-state" data-tone="danger">
      <XCircleIcon />
      <div>{t.invalidTitle}</div>
      <p>{t.invalidDesc}</p>
      <Link
        href="/account"
        className="account-link"
      >
        {t.goPortal}
      </Link>
    </div>
  );
}
