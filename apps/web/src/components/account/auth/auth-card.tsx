import "../account.css";

import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import Link from "next/link";
import { CheckIcon } from "lucide-react";
import {
  AccountThemeScript,
  AccountThemeToggle,
} from "@/components/account/account-theme";

export function AuthCard({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("account-auth", className)}>
      <AccountThemeScript />
      <div className="account-auth__shell">
        <header className="account-auth__nav">
          <Link href="/" className="account-auth__brand" aria-label="返回冰茶AI官网">
            <img src="/bcai-icon.png" alt="" />
            <span>
              <strong>冰茶AI</strong>
              <span>BINGCHA AI</span>
            </span>
          </Link>
          <AccountThemeToggle />
        </header>

        <main className="account-auth__grid">
          <aside className="account-auth__aside">
            <span className="account-auth__eyebrow">
              <span className="account-status-lamp" data-tone="success" />
              MEMBERSHIP · 冰茶AI
            </span>
            <h1>
              欢迎来到<span className="am">冰茶</span>
              <br />
              会员中心
            </h1>
            <p className="account-auth__lead">
              登录后接管 <b>Codex</b>、<b>Claude Code</b> 与 <b>Antigravity</b>,统一管理订阅、设备、额度与支付。
            </p>

            <div className="account-auth__passdemo" aria-hidden>
              <div className="account-pass-wrap">
                <div className="account-pass">
                  <div className="account-pass__top">
                    <div>
                      <div className="account-pass__lab">MEMBER PASS</div>
                      <div className="account-pass__brand">
                        <span className="mk">
                          <img src="/bcai-icon.png" alt="" />
                        </span>
                        冰茶AI
                      </div>
                    </div>
                    <span className="account-pass__tier">MEMBER</span>
                  </div>
                  <div className="account-pass__chip" />
                  <div className="account-pass__mid">
                    <div className="account-pass__plan">
                      会员通行证
                      <small>MEMBERSHIP · 冰茶AI</small>
                    </div>
                  </div>
                  <div className="account-pass__bot">
                    <div className="account-pass__id">
                      <small>MEMBER ID</small>
                      BCAI · ＿＿＿＿
                    </div>
                    <div className="account-pass__thru">
                      <small>VALID THRU</small>
                      <b>— / —</b>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="account-auth__trust">
              <div>
                <strong>
                  <CheckIcon />
                  本地只注入 Token
                </strong>
                <p>不改你的工具链。</p>
              </div>
              <div>
                <strong>
                  <CheckIcon />
                  请求直连官方
                </strong>
                <p>冰茶不做中间人。</p>
              </div>
              <div>
                <strong>
                  <CheckIcon />
                  同账户核对
                </strong>
                <p>套餐、设备、订单统一查看。</p>
              </div>
            </div>
          </aside>

          <section className="account-auth__panel" aria-label={title}>
            <div className="account-auth__panel-head">
              <h1>{title}</h1>
              {description && <p>{description}</p>}
            </div>

            {children}

            <footer className="account-auth__footer">
              <p>登录后可购买套餐、绑定卡密、管理设备和订单。</p>
              <div>
                <Link href="/download" className="account-link">
                  下载客户端
                </Link>
                <Link href="/" className="account-link">
                  返回官网
                </Link>
              </div>
            </footer>
          </section>
        </main>
      </div>
    </div>
  );
}
