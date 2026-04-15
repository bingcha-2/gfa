import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import {
  getConsoleTokenFromCookie,
  serverApiRequest,
} from "@/lib/server-api";

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

  return <LoginForm />;
}
