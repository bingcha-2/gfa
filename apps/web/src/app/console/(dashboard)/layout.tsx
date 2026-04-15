import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getConsoleBootstrapData, getConsoleTokenFromCookie } from "@/lib/server-api";
import { ConsoleLayout } from "@/components/console-layout";

export const dynamic = "force-dynamic";

export default async function Layout({ children }: { children: ReactNode }) {
  const token = await getConsoleTokenFromCookie();

  if (!token) {
    redirect("/console/login");
  }

  try {
    const data = await getConsoleBootstrapData(token);

    return (
      <ConsoleLayout initialUser={data.user} initialStats={data.stats}>
        {children}
      </ConsoleLayout>
    );
  } catch {
    redirect("/console/login");
  }
}
