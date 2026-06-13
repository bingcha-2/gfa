import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getCustomerFromCookie } from "@/lib/account/user-server-api";

export const dynamic = "force-dynamic";

/**
 * Auth layout — redirect to /account ONLY when the backend confirms the session.
 *
 * This guard pushes an already-logged-in user OFF the login page, so it must use
 * the SAME authority as the (main) layout — a backend /me check — not mere cookie
 * presence. A cookie can outlive its session (30-day expiry, backend restart,
 * revoked token); redirecting on presence alone makes a stale cookie bounce
 * /account/login → /account while (main) bounces /account → /account/login: an
 * infinite 307 loop. getCustomerFromCookie() short-circuits with no backend call
 * when no cookie is present, so the common "logged-out visitor opens the login
 * page" path stays a zero-roundtrip render.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const customer = await getCustomerFromCookie();
  if (customer) {
    redirect("/account");
  }
  return <>{children}</>;
}
