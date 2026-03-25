import Link from "next/link";
import { redirect } from "next/navigation";

import { LoginForm } from "../../../components/login-form";
import { getConsoleTokenFromCookie, serverApiRequest } from "../../../lib/server-api";

export const dynamic = "force-dynamic";

export default async function ConsoleLoginPage() {
  const token = await getConsoleTokenFromCookie();

  if (token) {
    try {
      await serverApiRequest("auth/me", token);
      redirect("/console");
    } catch {
      // Ignore invalid cookie and continue rendering login page.
    }
  }

  return (
    <main className="page-shell compact">
      <nav className="nav-strip">
        <div className="nav-brand">
          <div className="nav-mark">GO</div>
          <span>Operator Login</span>
        </div>

        <div className="nav-links">
          <Link className="pill-link" href="/">
            返回首页
          </Link>
          <Link className="pill-link" href="/redeem">
            公共提交流程
          </Link>
        </div>
      </nav>

      <section className="auth-shell">
        <LoginForm />
      </section>
    </main>
  );
}
