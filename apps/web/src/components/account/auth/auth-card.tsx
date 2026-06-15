"use client";

import "../account.css";

import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import Link from "next/link";
import { CheckIcon } from "lucide-react";
import {
  AccountThemeScript,
  AccountThemeToggle,
} from "@/components/account/account-theme";
import { useDict } from "@/lib/i18n/client";
import { marketingUrl } from "@/lib/marketing-url";

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
  const dict = useDict();
  const a = dict.portalApp.auth;

  return (
    <div className={cn("account-auth", className)}>
      <AccountThemeScript />
      <div className="account-auth__shell">
        <header className="account-auth__nav">
          <Link href="/" className="account-auth__brand" aria-label={a.backToSite}>
            <img src="/bcai-icon.png" alt="" />
            <span>
              <strong>{dict.common.brandName}</strong>
              <span>BINGCHA AI</span>
            </span>
          </Link>
          <AccountThemeToggle />
        </header>

        <main className="account-auth__grid">
          <aside className="account-auth__aside">
            <span className="account-auth__eyebrow">
              <span className="account-status-lamp" data-tone="success" />
              {a.eyebrow}
            </span>
            <h1>
              {a.welcomePre}
              <span className="am">{a.welcomeBrand}</span>
              <br />
              {a.welcomeTitle}
            </h1>
            <p className="account-auth__lead">{a.lead}</p>

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
                        {dict.common.brandName}
                      </div>
                    </div>
                    <span className="account-pass__tier">MEMBER</span>
                  </div>
                  <div className="account-pass__chip" />
                  <div className="account-pass__mid">
                    <div className="account-pass__plan">
                      {a.passTitle}
                      <small>{a.passMembership}</small>
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
                  {a.trust1Title}
                </strong>
                <p>{a.trust1Desc}</p>
              </div>
              <div>
                <strong>
                  <CheckIcon />
                  {a.trust2Title}
                </strong>
                <p>{a.trust2Desc}</p>
              </div>
              <div>
                <strong>
                  <CheckIcon />
                  {a.trust3Title}
                </strong>
                <p>{a.trust3Desc}</p>
              </div>
            </div>
          </aside>

          <section className="account-auth__panel account-auth-card" aria-label={title}>
            <div className="account-auth-card__brand" aria-hidden>
              <img src="/bcai-icon.png" alt="" />
              <span>{dict.common.brandName}</span>
            </div>
            <div className="account-auth__panel-head">
              <h1>{title}</h1>
              {description && <p>{description}</p>}
            </div>

            {children}

            <footer className="account-auth__footer">
              <p>{a.footerNote}</p>
              <div>
                <Link href={marketingUrl("/download")} className="account-link">
                  {dict.common.downloadClient}
                </Link>
                <Link href={marketingUrl("/")} className="account-link">
                  {a.backToSiteShort}
                </Link>
              </div>
            </footer>
          </section>
        </main>
      </div>
    </div>
  );
}
