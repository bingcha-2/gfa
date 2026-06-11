import { redirect } from "next/navigation";

import { ConsoleLoginForm } from "@/components/console/shell/console-login-form";
import {
  getConsoleTokenFromCookie,
  serverApiRequest,
} from "@/lib/console/server-api";

export const dynamic = "force-dynamic";

export default async function ConsoleLoginPage() {
  const token = await getConsoleTokenFromCookie();

  if (token) {
    try {
      await serverApiRequest("auth/me", token);
      const prefix =
        (process.env.ADMIN_PATH_PREFIX ?? "console").replace(
          /^\/|\/$/g,
          ""
        ) || "console";
      redirect(`/${prefix}`);
    } catch {
      // Invalid cookie — continue rendering login page.
    }
  }

  return <ConsoleLoginForm />;
}
