"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2Icon, XCircleIcon } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
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
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <XCircleIcon className="size-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t.missingToken}</p>
        <Link
          href="/account"
          className="text-sm text-accent underline-offset-4 hover:underline"
        >
          {t.goPortal}
        </Link>
      </div>
    );
  }

  if (state === "verifying") {
    return (
      <div className="flex flex-col items-center gap-3 py-6">
        <Skeleton className="size-10 rounded-full" />
        <p className="text-sm text-muted-foreground">{t.verifying}</p>
      </div>
    );
  }

  if (state === "success") {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <CheckCircle2Icon className="size-10 text-emerald-600 dark:text-emerald-400" />
        <div className="text-base font-semibold">{t.successTitle}</div>
        <p className="text-sm text-muted-foreground">{t.successDesc}</p>
        <Link
          href="/account"
          className="text-sm text-accent underline-offset-4 hover:underline"
        >
          {t.goPortal}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <XCircleIcon className="size-10 text-destructive" />
      <div className="text-base font-semibold">{t.invalidTitle}</div>
      <p className="text-sm text-muted-foreground">{t.invalidDesc}</p>
      <Link
        href="/account"
        className="text-sm text-accent underline-offset-4 hover:underline"
      >
        {t.goPortal}
      </Link>
    </div>
  );
}
