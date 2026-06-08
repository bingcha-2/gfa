import { MarketingShell } from "../_marketing/shell";

export const metadata = {
  title: "快速开始 — 冰茶AI",
  description: "三步上手冰茶AI：下载客户端、输入卡密、一键接管。不到 30 秒开始使用。",
};

const Card = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20M6 15h4" />
  </svg>
);

const STEPS = [
  { t: "下载客户端", d: "前往下载页获取适合你系统的版本。Windows 免安装，macOS 拖入应用程序文件夹，Linux 解压运行。", link: { href: "/download", label: "前往下载 →" } },
  { t: "输入卡密", d: "启动客户端后，在「账号卡配置」输入续杯卡密（格式 AI…），点击「验证激活」。卡密可在 bcai.store 购买。" },
  { t: "一键接管", d: "在「接管」面板选择要接管的产品（IDE / Hub / Codex / Claude Code），点击开关即可，IDE 请求自动经过本地代理。" },
];

const TAKEOVER = [
  ["Antigravity IDE", "Gemini、Claude 双模型自动接管，体验与原生一致"],
  ["Antigravity Hub", "Hub 内所有 AI 功能全覆盖，不影响其他功能"],
  ["OpenAI Codex", "codex 命令直接用，自动获得 Plus / Pro 配额"],
  ["Claude Code", "CLI、VS Code 扩展均支持，直连 Max / Pro 订阅"],
  ["Claude Desktop", "macOS / Windows 双平台桌面端透明接管"],
];

export default function QuickstartPage() {
  return (
    <MarketingShell anim={false}>
      <section className="mkt-section mkt-section--tight">
        <div className="mkt-wrap">
          <div className="mkt-pagehead">
            <span className="mkt-pagehead__eyebrow">/ 快速开始</span>
            <h1>三步，30 秒用起来</h1>
            <p>下载客户端、输入卡密、一键接管，不用配 API Key、不用换工具。</p>
          </div>

          {/* 三步 */}
          <div className="mkt-block">
            <div className="mkt-steps">
              {STEPS.map((s, i) => (
                <div className="mkt-step" key={s.t}>
                  <span className="mkt-step__n">{i + 1}</span>
                  <div className="mkt-step__t">{s.t}</div>
                  <p className="mkt-step__d">{s.d}</p>
                  {s.link && (
                    <a href={s.link.href} style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--primary-text)" }}>{s.link.label}</a>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 关于卡密 */}
          <div className="mkt-block">
            <h2>关于卡密</h2>
            <div className="mkt-note">
              <div className="mkt-note__h"><Card />卡密是什么？</div>
              <p>卡密是你使用冰茶AI 的凭证，格式为 AI…。每张卡有固定的有效期和支持的产品范围，到期可购买新卡续费。</p>
            </div>
            <div className="mkt-spec" style={{ marginTop: "1.5rem" }}>
              {[
                ["在哪买", <>卡密可在 <a href="https://bcai.store" target="_blank" rel="noopener noreferrer" style={{ color: "var(--primary-text)", fontWeight: 600 }}>bcai.store</a> 购买。</>],
                ["看到期", "激活后可在客户端查看到期时间。"],
                ["续费", "到期前随时输入新卡密续费，无缝衔接。"],
                ["套餐", "不同套餐支持不同产品组合（Antigravity / Codex / Claude）。"],
              ].map(([k, v], i) => (
                <div className="mkt-spec__item" key={i}>
                  <span className="mkt-spec__name">{k}</span>
                  <p className="mkt-cap__d" style={{ margin: 0 }}>{v}</p>
                </div>
              ))}
            </div>
          </div>

          {/* 接管面板 */}
          <div className="mkt-block">
            <h2>接管面板</h2>
            <div className="mkt-prose" style={{ marginBottom: "1.25rem" }}>
              <p>冰茶AI 支持对 5 个产品目标独立接管，每个都有独立开关：</p>
            </div>
            <div className="mkt-spec">
              {TAKEOVER.map(([n, d]) => (
                <div className="mkt-spec__item" key={n as string}>
                  <span className="mkt-spec__name">{n}</span>
                  <p className="mkt-cap__d" style={{ margin: 0 }}>{d}</p>
                </div>
              ))}
            </div>
          </div>

          {/* CTA */}
          <div className="mkt-cta" style={{ marginTop: "1rem" }}>
            <div className="mkt-hero__glow" />
            <h2>还没有卡密？</h2>
            <p>前往冰茶商店购买续杯卡，多种套餐可选。</p>
            <div className="mkt-cta__btns">
              <a href="https://bcai.store" target="_blank" rel="noopener noreferrer" className="mkt-btn mkt-btn--primary">购买卡密 ↗</a>
              <a href="/download" className="mkt-btn mkt-btn--ghost">下载客户端</a>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
