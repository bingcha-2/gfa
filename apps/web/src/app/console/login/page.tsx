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

      <section className="content-grid">
        <article className="hero-card">
          <div className="hero-copy">
            <span className="eyebrow">Control Room</span>
            <h1 className="hero-title">运营台只做两件事: 看清状态，快速接管。</h1>
            <p className="lead">
              登录后控制台会并行拉取账号、家庭组、订单、任务和卡密数据。这个版本优先服务运营，不做复杂权限分层和细颗粒流程引导。
            </p>
          </div>
        </article>

        <LoginForm />
      </section>
    </main>
  );
}
