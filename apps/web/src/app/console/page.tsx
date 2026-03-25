import { redirect } from "next/navigation";

import { ConsoleApp } from "../../components/console-app";
import { getConsoleBootstrapData, getConsoleTokenFromCookie } from "../../lib/server-api";

export const dynamic = "force-dynamic";

export default async function ConsolePage() {
  const token = await getConsoleTokenFromCookie();

  if (!token) {
    redirect("/console/login");
  }

  try {
    const data = await getConsoleBootstrapData(token);

    return (
      <main className="page-shell">
        <ConsoleApp initialData={data} />
      </main>
    );
  } catch {
    redirect("/console/login");
  }
}
