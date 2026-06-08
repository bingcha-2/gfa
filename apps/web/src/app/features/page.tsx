import { MarketingShell } from "../_marketing/shell";

export const metadata = {
  title: "客户端功能 — 冰茶AI",
  description: "冰茶AI 桌面客户端：实时仪表盘、模型额度血条、接管控制、费用追踪、全平台支持。",
};

const ic = (d: string, sw = "2") => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d.split("|").map((p, i) => <path key={i} d={p} />)}
  </svg>
);

const DASH = [
  { t: "今日请求数", d: "实时统计 AI 模型请求总量，精确到每一次调用。" },
  { t: "错误统计", d: "记录请求失败次数，帮助你快速识别问题。" },
  { t: "输入 / 输出 Token", d: "分别统计发送与返回的 Token 数量。" },
  { t: "已省费用", d: "按实际模型与官方订阅价实时计算，醒目绿色数字一眼看到价值。" },
];

const MODELS = [
  { name: "Claude（Anthropic）", win: "5 小时窗口 + 每周窗口", dot: "var(--claude)", desc: "双窗口独立计算，血条实时更新，显示额度重置倒计时。" },
  { name: "Codex（OpenAI）", win: "5 小时窗口 + 每周窗口", dot: "var(--codex)", desc: "双窗口机制，精准追踪 ChatGPT Plus / Pro 配额。" },
  { name: "Gemini（Google）", win: "单一额度池", dot: "var(--anti)", desc: "Antigravity IDE 中的 Gemini 用量，显示已用 / 总量。" },
];

const TAKEOVER = [
  { name: "Antigravity IDE", s: "Gemini + Claude 双模型" },
  { name: "Antigravity Hub", s: "全部 AI 功能覆盖" },
  { name: "OpenAI Codex", s: "Plus / Pro 配额直用" },
  { name: "Claude Code", s: "CLI + VS Code 扩展" },
  { name: "Claude Desktop", s: "macOS / Windows" },
];

const MORE = [
  { t: "自动更新", d: "内置 OTA 推送，新版本自动下载安装。", p: "M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.7-3L3 16|M3 21v-5h5|M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.7 3L21 8|M21 3v5h-5" },
  { t: "前置代理", d: "可配上游 HTTP / SOCKS5 代理，受限环境也能用。", p: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20|M2 12h20|M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20" },
  { t: "公告系统", d: "实时接收运营公告与维护通知。", p: "M3 11l18-5v12L3 14v-3z|M11.6 16.8a3 3 0 1 1-5.8-1.6" },
  { t: "请求日志", d: "完整记录每次请求的时间、模型、状态码。", p: "M4 4h16v16H4z|M8 9h8|M8 13h6|M8 17h4" },
  { t: "路径检测", d: "自动检测 IDE / Hub / Codex 安装路径，也支持手动。", p: "M21 21l-4.3-4.3|M11 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12z" },
  { t: "全平台覆盖", d: "Windows · macOS（Intel + Apple Silicon）· Linux。", p: "M3 4h18v12H3z|M8 20h8|M12 16v4" },
];

const SETTINGS = [
  ["前置代理", "上游 HTTP / SOCKS5 代理地址，适用受限网络。"],
  ["IDE 路径", "Antigravity IDE 安装目录，自动检测或手动浏览。"],
  ["Hub 路径", "Antigravity Hub 安装目录，同样支持自动检测。"],
  ["Codex 路径", "Codex CLI 安装路径配置。"],
];

const dot = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
);

export default function FeaturesPage() {
  return (
    <MarketingShell anim={false}>
      <section className="mkt-section mkt-section--tight">
        <div className="mkt-wrap">
          <div className="mkt-pagehead">
            <span className="mkt-pagehead__eyebrow">/ 客户端功能</span>
            <h1>掌控每一次 AI 调用</h1>
            <p>原生桌面客户端，内置仪表盘，让你随时掌握用量、额度与接管状态。</p>
          </div>

          {/* 客户端一览 */}
          <div className="mkt-block">
            <figure className="mkt-imgframe">
              <img src="/product-shots/client-preview-beautified.png" alt="冰茶AI 客户端控制台，展示请求统计、模型额度血条与接管状态" />
            </figure>
            <p className="mkt-imgcap">客户端控制台 — 实时显示请求统计、模型用量、接管状态</p>
          </div>

          {/* 实时仪表盘 */}
          <div className="mkt-block">
            <h2>实时仪表盘</h2>
            <div className="mkt-caps">
              {DASH.map((s) => (
                <div className="mkt-cap" key={s.t}>
                  <span className="mkt-cap__icon">{dot}</span>
                  <div><div className="mkt-cap__t">{s.t}</div><p className="mkt-cap__d">{s.d}</p></div>
                </div>
              ))}
            </div>
          </div>

          {/* 模型用量监控 */}
          <div className="mkt-block">
            <h2>模型额度血条</h2>
            <div className="mkt-prose" style={{ marginBottom: "1.25rem" }}>
              <p>客户端内置<strong>实时血条</strong>显示每个模型的额度消耗，不同产品有不同的额度窗口：</p>
            </div>
            <div className="mkt-spec">
              {MODELS.map((m) => (
                <div className="mkt-spec__item" key={m.name} style={{ ["--dot" as string]: m.dot }}>
                  <span className="mkt-spec__name">{m.name}<span style={{ fontFamily: "var(--font-mono), monospace", fontSize: "0.78rem", color: "var(--ink-muted)", fontWeight: 400 }}>{m.win}</span></span>
                  <p className="mkt-cap__d" style={{ margin: 0 }}>{m.desc}</p>
                </div>
              ))}
            </div>
            <div className="mkt-note">
              <div className="mkt-note__h">{ic("M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1h6c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z|M9 18h6|M10 22h4")}额度重置倒计时</div>
              <p>额度接近用完时，血条会显示多久后恢复，方便你安排工作节奏。</p>
            </div>
          </div>

          {/* 接管控制 */}
          <div className="mkt-block">
            <h2>接管控制面板</h2>
            <div className="mkt-prose" style={{ marginBottom: "1.25rem" }}>
              <p>每个产品独立开关，<strong>按需选择接管哪些工具</strong>，不用的保持原生状态不受影响。</p>
            </div>
            <div className="mkt-fgrid">
              {TAKEOVER.map((p) => (
                <div className="mkt-fcard" key={p.name} style={{ display: "flex", alignItems: "center", gap: "0.8rem" }}>
                  <span className="mkt-fcard__icon" style={{ margin: 0, flexShrink: 0 }}>{dot}</span>
                  <div><div className="mkt-fcard__t" style={{ marginBottom: 0 }}>{p.name}</div><div className="mkt-fcard__d">{p.s}</div></div>
                </div>
              ))}
            </div>
          </div>

          {/* 更多亮点 */}
          <div className="mkt-block">
            <h2>更多亮点</h2>
            <div className="mkt-fgrid">
              {MORE.map((h) => (
                <div className="mkt-fcard" key={h.t}>
                  <span className="mkt-fcard__icon">{ic(h.p)}</span>
                  <div className="mkt-fcard__t">{h.t}</div>
                  <div className="mkt-fcard__d">{h.d}</div>
                </div>
              ))}
            </div>
          </div>

          {/* 设置 */}
          <div className="mkt-block">
            <h2>设置页面</h2>
            <div className="mkt-spec">
              {SETTINGS.map(([n, d]) => (
                <div className="mkt-spec__item" key={n}>
                  <span className="mkt-spec__name">{n}</span>
                  <p className="mkt-cap__d" style={{ margin: 0 }}>{d}</p>
                </div>
              ))}
            </div>
          </div>

          {/* CTA */}
          <div className="mkt-cta" style={{ marginTop: "1rem" }}>
            <div className="mkt-hero__glow" />
            <h2>想亲自体验？</h2>
            <p>下载冰茶AI 客户端，感受这些功能。</p>
            <div className="mkt-cta__btns">
              <a href="/download" className="mkt-btn mkt-btn--primary">下载客户端</a>
              <a href="https://bcai.store" target="_blank" rel="noopener noreferrer" className="mkt-btn mkt-btn--ghost">购买卡密 ↗</a>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
