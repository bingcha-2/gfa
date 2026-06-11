"use client";

import { useDict } from "@/lib/i18n/client";

/** 客户端仪表盘产品图(HTML/CSS 绘制,不依赖截图图片)。 */
export function ClientMock() {
  const t = useDict();
  return (
    <div className="mkt-mock" aria-hidden>
      <div className="mkt-mock__glass">
        <div className="mkt-mock__bar">
          <span className="mkt-mock__dot" style={{ background: "#ff5f57" }} />
          <span className="mkt-mock__dot" style={{ background: "#febc2e" }} />
          <span className="mkt-mock__dot" style={{ background: "#28c840" }} />
          <span className="mkt-mock__title">
            <img src="/bcai-icon.png" alt="" />
            BingchaAI
          </span>
        </div>

        <div className="mkt-mock__body">
          <div className="mkt-mock__status">
            <span>{t.mock.proxyStatus}</span>
            <span className="mkt-pill mkt-pill--ok">{t.mock.running}</span>
            <span style={{ marginLeft: "auto", opacity: 0.6, fontFamily: "var(--font-mono), monospace", fontSize: "0.72rem" }}>
              127.0.0.1:60670
            </span>
          </div>

          <div className="mkt-mock__stats">
            {[
              { k: t.mock.todayRequests, v: "1,247" },
              { k: t.mock.errors, v: "3" },
              { k: t.mock.inputTokens, v: "2.4M" },
              { k: t.mock.outputTokens, v: "890K" },
            ].map((s) => (
              <div className="mkt-stat" key={s.k}>
                <div className="mkt-stat__k">{s.k}</div>
                <div className="mkt-stat__v">{s.v}</div>
              </div>
            ))}
          </div>

          <div className="mkt-mock__cols">
            <div className="mkt-panel">
              <div className="mkt-panel__h">{t.mock.takeoverStatus}</div>
              {[
                { n: "Antigravity", on: true },
                { n: "OpenAI Codex", on: true },
                { n: "Claude Code", on: false },
              ].map((r) => (
                <div className="mkt-row" key={r.n}>
                  <span>{r.n}</span>
                  <span className={`mkt-pill ${r.on ? "mkt-pill--ok" : "mkt-pill--muted"}`}>
                    {r.on ? t.mock.takenOver : t.mock.notTakenOver}
                  </span>
                </div>
              ))}
            </div>

            <div className="mkt-panel">
              <div className="mkt-panel__h">{t.mock.modelQuota}</div>
              {[
                { n: "Claude Opus", p: 65, c: "oklch(0.7 0.18 45)" },
                { n: "Gemini", p: 82, c: "oklch(0.62 0.16 255)" },
                { n: "Codex GPT-5", p: 45, c: "oklch(0.66 0.15 160)" },
              ].map((u) => (
                <div className="mkt-usage" key={u.n}>
                  <div className="mkt-usage__top">
                    <span>{u.n}</span>
                    <span style={{ opacity: 0.7 }}>{u.p}%</span>
                  </div>
                  <div className="mkt-bar">
                    <i style={{ width: `${u.p}%`, background: u.c }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
