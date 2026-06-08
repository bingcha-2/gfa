import { MarketingShell } from "../_marketing/shell";

export const metadata = {
  title: "工作原理 — 冰茶AI",
  description: "冰茶AI 在你电脑和官方 API 之间做了什么：本地代理注入令牌，直连官方服务器，不做中间人。",
};

const Bulb = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1h6c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
  </svg>
);
const Lock = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);
const Check = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const FLOW = [
  { t: "拦截请求", d: "本地代理（127.0.0.1）透明拦截 IDE 发往官方的请求。Claude Code 改环境变量、Codex 切 provider、Claude 桌面端走本地 MITM。" },
  { t: "按需租号", d: "租号引擎实时从号池租一个真实官方账号令牌（含额度与有效期），并发去重 + 令牌缓存，几乎不增加延迟。" },
  { t: "替换直连", d: "代理把请求里的占位令牌换成真实令牌，直发 api.anthropic.com / chatgpt.com 官方端点，可选经固定住宅出口。" },
  { t: "流式回传", d: "官方响应原路返回 IDE，边转发边统计 Token 用量；体验与原生订阅完全一致。" },
];

const POOL = [
  { t: "自动续租", d: "令牌有效期内自动续租，到期前无缝切到新令牌。" },
  { t: "额度耗尽切换", d: "当前账号额度用完，自动切到号池中其他有余量的账号。" },
  { t: "风控隔离", d: "账号被平台风控时自动标记不可用并移出号池，不波及其他用户。" },
  { t: "自动补号", d: "后台持续补充新账号到号池，确保可用账号数量充足。" },
];

const PRODUCTS = [
  { name: "Antigravity（IDE · Hub）", dot: "var(--anti)", items: ["Gemini、Claude 双模型自动接管", "IDE / Hub 内体验与原生订阅一致", "退出接管自动恢复原始状态"] },
  { name: "OpenAI Codex CLI", dot: "var(--codex)", items: ["codex 命令直接用，无需手动取令牌", "自动获得 ChatGPT Plus / Pro 配额", "与官方 CLI 体验完全一致"] },
  { name: "Claude Code · Desktop", dot: "var(--claude)", items: ["CLI、VS Code 扩展、macOS/Windows 桌面端", "不改 Claude 任何配置文件，可一键还原", "直连 Max / Pro 订阅额度"] },
];

const SAFE = [
  ["不发 API Key", "用官方订阅额度，不是 API 转发。"],
  ["不改 IDE 配置", "接管退出后自动恢复原始配置。"],
  ["不收集代码", "本地代理仅注入令牌，代码直达官方。"],
  ["不做中间人", "请求数据不经过冰茶服务器。"],
];

export default function HowItWorksPage() {
  return (
    <MarketingShell anim={false}>
      <section className="mkt-section mkt-section--tight">
        <div className="mkt-wrap">
          <div className="mkt-pagehead">
            <span className="mkt-pagehead__eyebrow">/ 工作原理</span>
            <h1>本地注入令牌，官方直连</h1>
            <p>冰茶AI 在你电脑和官方 API 之间，到底做了什么。</p>
          </div>

          {/* 架构概述 */}
          <div className="mkt-block">
            <h2>架构概述</h2>
            <div className="mkt-prose">
              <p>
                冰茶AI 在你电脑上运行一个<strong>轻量级本地代理</strong>。它不是云端中转——你的代码和 AI 对话数据
                <strong>不经过我们的服务器</strong>，而是直接发往 Google、OpenAI、Anthropic 的官方 API 端点。
              </p>
            </div>
            <div className="mkt-note">
              <div className="mkt-note__h"><Bulb />核心理念</div>
              <p>冰茶AI 只做一件事：为你的请求注入正确的官方订阅令牌。不修改请求内容、不缓存响应、不记录代码——纯粹的令牌注入层。</p>
            </div>
          </div>

          {/* 请求生命周期 */}
          <div className="mkt-block">
            <h2>请求生命周期</h2>
            <div className="mkt-steps">
              {FLOW.map((s, i) => (
                <div className="mkt-step" key={s.t}>
                  <span className="mkt-step__n">{i + 1}</span>
                  <div className="mkt-step__t">{s.t}</div>
                  <p className="mkt-step__d">{s.d}</p>
                </div>
              ))}
            </div>
          </div>

          {/* 号池轮换 */}
          <div className="mkt-block">
            <h2>号池轮换机制</h2>
            <div className="mkt-prose" style={{ marginBottom: "1.25rem" }}>
              <p>冰茶后台维护着真实官方订阅账号的号池，你的客户端通过「租号」动态获取可用账号：</p>
            </div>
            <div className="mkt-caps">
              {POOL.map((f) => (
                <div className="mkt-cap" key={f.t}>
                  <span className="mkt-cap__icon"><Check /></span>
                  <div>
                    <div className="mkt-cap__t">{f.t}</div>
                    <p className="mkt-cap__d">{f.d}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 各产品接管体验 */}
          <div className="mkt-block">
            <h2>各产品接管体验</h2>
            <div className="mkt-spec">
              {PRODUCTS.map((p) => (
                <div className="mkt-spec__item" key={p.name} style={{ ["--dot" as string]: p.dot }}>
                  <span className="mkt-spec__name">{p.name}</span>
                  <ul className="mkt-spec__list">
                    {p.items.map((h) => <li key={h}>{h}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          {/* 安全模型 */}
          <div className="mkt-block" style={{ marginBottom: 0 }}>
            <h2>安全模型</h2>
            <div className="mkt-trust">
              <div className="mkt-trust__head">
                <span className="mkt-trust__badge"><Lock /></span>
                <div>
                  <h3 className="mkt-h2" style={{ fontSize: "clamp(1.4rem, 2.2vw, 1.75rem)" }}>我们的安全承诺</h3>
                  <p className="mkt-lead" style={{ marginTop: "0.35rem" }}>代码直达官方，本地代理只注入令牌。</p>
                </div>
              </div>
              <div className="mkt-trust__points">
                {SAFE.map(([b, s]) => (
                  <div className="mkt-trust__point" key={b}>
                    <b><Check />{b}</b>
                    <span>{s}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
