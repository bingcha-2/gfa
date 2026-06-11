"use client";

/**
 * /app/verify-email — deliberately a STANDALONE segment:
 * - NOT under (auth): its layout redirects logged-in users to /app, which
 *   would skip verification for an already-logged-in user clicking the link.
 * - NOT under (main): its server guard requires a session, but the user may
 *   be logged out when opening the link from their inbox.
 * The middleware exempts this path from the cookie redirect (PORTAL_AUTH_PAGES).
 */

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { AuthCard } from "@/components/portal/auth/auth-card";
import { VerifyEmailFlow } from "@/components/portal/verify-email-flow";
import { useDict } from "@/lib/i18n/client";

function VerifyEmailInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  return <VerifyEmailFlow token={token} />;
}

export default function VerifyEmailPage() {
  const dict = useDict();

  return (
    <AuthCard title={dict.common.brandName}>
      <Suspense>
        <VerifyEmailInner />
      </Suspense>
    </AuthCard>
  );
}
