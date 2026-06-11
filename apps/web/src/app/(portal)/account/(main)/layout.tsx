import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { serverUserApi } from "@/lib/user-server-api";
import { PortalShell } from "@/components/portal/portal-shell";
import type { Customer } from "@/lib/user-types";

export const dynamic = "force-dynamic";

/**
 * Main portal layout — server guard.
 * Reads the user cookie, calls /web/me to validate; on failure redirects to /app/login.
 */
export default async function MainLayout({ children }: { children: ReactNode }) {
  let customer: Customer;

  try {
    customer = await serverUserApi<Customer>("me");
  } catch {
    redirect("/account/login");
  }

  return <PortalShell initialCustomer={customer}>{children}</PortalShell>;
}
