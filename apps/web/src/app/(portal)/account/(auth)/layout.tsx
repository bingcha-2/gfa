import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getUserTokenFromCookie } from "@/lib/user-server-api";

export const dynamic = "force-dynamic";

/**
 * Auth layout — if user already has a valid cookie, redirect to /app.
 * Does NOT verify the token with the backend (avoids latency on login page);
 * the (main) layout does the authoritative backend check.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const token = await getUserTokenFromCookie();
  if (token) {
    redirect("/account");
  }
  return <>{children}</>;
}
