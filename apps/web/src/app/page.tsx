import { MarketingShell } from "./_marketing/shell";
import { ClientMock } from "./_marketing/client-mock";

/* ───────── 图标 ───────── */
const I = {
  download: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  rotate: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
    </svg>
  ),
  chart: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 3v18h18M7 15l3-4 3 2 4-6" />
    </svg>
  ),
  zap: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z" />
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  ),
  sliders: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  globe: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),
};

const ECOSYSTEMS = [
  {
    name: "Antigravity",
    tag: "IDE · Hub",
    logo: "/logos/antigravity.svg",
    desc: "Google 旗下 AI 编程 IDE。接管后 Gemini / Claude 模型请求自动走冰茶号池，编辑器无感。",
  },
  {
    name: "OpenAI Codex",
    tag: "CLI",
    logo: "/logos/codex.svg",
    desc: "OpenAI 的 AI 编程代理。自动获取 ChatGPT Plus / Pro 令牌，codex 命令直接用，不碰 API Key。",
  },
  {
    name: "Claude Code",
    tag: "CLI · VSCode · Desktop",
    logo: "/logos/claude.svg",
    desc: "Claude Code CLI、VS Code 扩展与 macOS 桌面端，直连 Max / Pro 订阅，额度耗尽自动续杯。",
  },
];

/* 工作原理：真实技术机制（本地注入 → 官方直连），是一条有序链路 */
const HOW = [
  { t: "本地起一个代理", d: "在本地起一个轻量代理，按各工具的标准方式接管，不动代码、可一键还原。" },
  { t: "按需租用官方账号", d: "工具一发请求，实时从号池租一个真实官方令牌，几乎不增加延迟。" },
  { t: "替换令牌，直连官方", d: "把占位令牌换成真令牌，直发官方端点，代码不经过冰茶。" },
  { t: "实时统计，自动换号", d: "边响应边统计用量；额度耗尽或遇风控时，自动切到备用账号。" },
];

/* 快速上手：用户视角的三步使用流程 */
const QUICKSTART = ["下载客户端", "输入卡密", "点击接管"];

const CAPS = [
  { icon: I.sliders, t: "智能号池调度", d: "不是随机发号。按账号亲和度、负载均衡、套餐等级和各模型剩余额度综合打分，每次都挑当下最优的账号。" },
  { icon: I.users, t: "共享 / 独享额度，自由选", d: "号池卡多人共享账号、更划算；绑定卡独享账号、额度更稳。多人共享同一账号时有公平限额算法，保证每人拿到应得的一份，不被别人占满。" },
  { icon: I.shield, t: "固定出口，风险隔离", d: "可选住宅级固定出口 IP，连接更稳、不易因 IP 触发风控；单个账号出问题只隔离它自己，自动换号补号，不波及其他用户。" },
  { icon: I.chart, t: "实时额度血条", d: "流式边响应边统计 Token，本地镜像服务端 5 小时滑动窗口，各模型按真实重置时间显示剩余额度，用量与已省费用一目了然。" },
  { icon: I.zap, t: "一键接管，零配置", d: "打开客户端 → 输入卡密 → 点接管，不配 API Key、不换工具、不学新东西，随时可一键还原。" },
];

const COMPARE: Array<[string, string, string, string]> = [
  ["使用官方订阅账号", "是", "是", "否（API Key）"],
  ["原生速度", "是", "是", "可能限速"],
  ["多产品覆盖", "三大生态", "需逐个订", "看中转商"],
  ["自动换号 / 封号兜底", "自动", "自负", "自负"],
  ["配置复杂度", "零配置", "需手动", "填 Key + 改配置"],
  ["可视化用量", "仪表盘", "无", "看中转商"],
];

const TRUST_POINTS = [
  { b: "不发 API Key", s: "客户端只注入授权令牌，不向第三方暴露任何密钥。" },
  { b: "不改 IDE 配置", s: "你的编辑器、插件、工作流维持原样，随时可一键停用。" },
  { b: "不收集代码", s: "代码数据直发官方服务器，冰茶不做中间人代理、不留存。" },
];

export default function HomePage() {
  return (
    <MarketingShell>
        {/* ════ Hero ════ */}
        <section className="mkt-hero">
          <div className="mkt-hero__glow" />
          <div className="mkt-wrap mkt-hero__grid">
            <div className="mkt-hero__copy">
              <span className="mkt-eyebrow mkt-reveal" data-d="1">/ 官方账号接管，一键续杯</span>
              <h1 className="mkt-h1">
                <span className="mkt-h1__line"><span className="mkt-h1__in">让 AI 编程工具</span></span>
                <span className="mkt-h1__line"><span className="mkt-h1__in">直连<span className="accent">官方账号</span></span></span>
              </h1>
              <p className="mkt-hero__sub mkt-reveal" data-d="2">
                冰茶AI 为你分配真实的官方订阅账号，让 Antigravity、Claude Code、Codex CLI
                像往常一样直连官方。不配 API Key、不换工具、不用自己扛风控。
              </p>
              <div className="mkt-hero__cta mkt-reveal" data-d="3">
                <a href="/download" className="mkt-btn mkt-btn--primary">
                  {I.download}
                  下载客户端
                </a>
                <a href="https://bcai.store" target="_blank" rel="noopener noreferrer" className="mkt-btn mkt-btn--ghost">
                  购买卡密 ↗
                </a>
              </div>
              <div className="mkt-hero__trust mkt-reveal" data-d="4">
                <span>{I.check}官方直连</span>
                <span>{I.check}不做中间人</span>
                <span>{I.check}代码不经过我们</span>
              </div>
            </div>
            <div className="mkt-hero__mock">
              <ClientMock />
            </div>
          </div>
        </section>

        {/* ════ 支持的工具 ════ */}
        <section className="mkt-section mkt-section--alt" id="products">
          <div className="mkt-wrap">
            <div className="mkt-section-head">
              <h2 className="mkt-h2">一个客户端，三个生态</h2>
              <p className="mkt-lead">主流 AI 编程工具开箱即用，接管后照常使用，模型请求自动走冰茶号池。</p>
            </div>
            <div className="mkt-grid-3">
              {ECOSYSTEMS.map((e) => (
                <article className="mkt-eco" key={e.name}>
                  <span className="mkt-eco__logo">
                    <img src={e.logo} alt={`${e.name} 标识`} width={28} height={28} loading="lazy" />
                  </span>
                  <div>
                    <div className="mkt-eco__name">{e.name}</div>
                    <div className="mkt-eco__tag">{e.tag}</div>
                  </div>
                  <p className="mkt-eco__desc">{e.desc}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ════ 工作原理 ════ */}
        <section className="mkt-section" id="how">
          <div className="mkt-wrap">
            <div className="mkt-section-head">
              <h2 className="mkt-h2">本地注入令牌，官方直连</h2>
              <p className="mkt-lead">
                把真实官方令牌注入到你本地的工具里，代码直发官方端点。冰茶只在本地代理层做令牌替换，不做中间人。
              </p>
            </div>
            <div className="mkt-steps">
              {HOW.map((s, i) => (
                <div className="mkt-step" key={s.t}>
                  <span className="mkt-step__n">{i + 1}</span>
                  <div className="mkt-step__t">{s.t}</div>
                  <p className="mkt-step__d">{s.d}</p>
                </div>
              ))}
            </div>

            <div className="mkt-quickstart">
              <span className="mkt-quickstart__label">快速上手</span>
              {QUICKSTART.map((q, i) => (
                <span className="mkt-qs" key={q}>
                  <span className="mkt-qs__n">{i + 1}</span>
                  <span className="mkt-qs__t">{q}</span>
                  {i < QUICKSTART.length - 1 && <span className="mkt-qs__arrow" aria-hidden>→</span>}
                </span>
              ))}
              <span className="mkt-quickstart__note">不到 30 秒，照常写代码</span>
            </div>
          </div>
        </section>

        {/* ════ 核心能力 ════ */}
        <section className="mkt-section mkt-section--alt" id="capabilities">
          <div className="mkt-wrap">
            <div className="mkt-section-head">
              <h2 className="mkt-h2">把号池的复杂，挡在你和官方之间</h2>
              <p className="mkt-lead">单账号会耗尽、会风控、会被占满。智能调度、固定出口、风险隔离，让你只管写代码。</p>
            </div>
            <div className="mkt-caps">
              {CAPS.map((c) => (
                <div className="mkt-cap" key={c.t}>
                  <span className="mkt-cap__icon">{c.icon}</span>
                  <div>
                    <div className="mkt-cap__t">{c.t}</div>
                    <p className="mkt-cap__d">{c.d}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ════ 对比 ════ */}
        <section className="mkt-section">
          <div className="mkt-wrap">
            <div className="mkt-section-head">
              <h2 className="mkt-h2">为什么选择冰茶AI</h2>
              <p className="mkt-lead">对比自行订阅和 API 中转，冰茶在覆盖、稳定和省心上都更划算。</p>
            </div>
            <div className="mkt-compare">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th className="col-us">冰茶AI</th>
                    <th>自行订阅</th>
                    <th>API 中转</th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARE.map(([label, us, own, relay]) => (
                    <tr key={label}>
                      <td>{label}</td>
                      <td className="col-us">{us}</td>
                      <td className="col-other">{own}</td>
                      <td className="col-other">{relay}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ════ 安全承诺 ════ */}
        <section className="mkt-section mkt-section--alt" id="trust">
          <div className="mkt-wrap">
            <div className="mkt-trust">
              <div className="mkt-trust__head">
                <span className="mkt-trust__badge">{I.lock}</span>
                <div>
                  <h2 className="mkt-h2" style={{ fontSize: "clamp(1.5rem, 2.4vw, 2rem)" }}>你的代码不经过我们</h2>
                  <p className="mkt-lead" style={{ marginTop: "0.35rem" }}>
                    冰茶AI 客户端运行在你本地电脑，只做一件事：把授权令牌注入到你的工具里。
                  </p>
                </div>
              </div>
              <div className="mkt-trust__points">
                {TRUST_POINTS.map((p) => (
                  <div className="mkt-trust__point" key={p.b}>
                    <b>{I.check}{p.b}</b>
                    <span>{p.s}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ════ 底部 CTA ════ */}
        <section className="mkt-section mkt-section--tight">
          <div className="mkt-wrap">
            <div className="mkt-cta">
              <div className="mkt-hero__glow" />
              <h2>准备好续杯了？</h2>
              <p>下载冰茶AI 客户端，或先到商店买一张卡密，30 秒后就能照常写代码。</p>
              <div className="mkt-cta__btns">
                <a href="/download" className="mkt-btn mkt-btn--primary">{I.download}下载客户端</a>
                <a href="https://bcai.store" target="_blank" rel="noopener noreferrer" className="mkt-btn mkt-btn--ghost">购买卡密 ↗</a>
              </div>
            </div>
          </div>
        </section>

    </MarketingShell>
  );
}
