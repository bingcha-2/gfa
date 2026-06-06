import { PublicShell } from "@/components/public-shell";

export const metadata = {
  title: "快速开始 — 冰茶AI",
  description: "三步上手冰茶AI：下载客户端、输入卡密、一键接管。不到 30 秒开始使用。",
};

export default function QuickstartPage() {
  return (
    <PublicShell>
      <div style={{ maxWidth: 740, padding: "52px 44px 96px", fontSize: 15, lineHeight: 1.85, color: "#57534e" }}>

        <h1 style={sH1}>快速开始</h1>
        <p style={sSub}>三步上手，不到 30 秒开始使用。</p>

        {/* ════ 三步流程 ════ */}
        <div style={{ position: "relative", margin: "32px 0 40px" }}>
          <div style={{ position: "absolute", left: 23, top: 32, bottom: 32, width: 2, background: "linear-gradient(180deg, #ea580c, #6366f1, #059669)", opacity: 0.1, borderRadius: 1 }} />
          {[
            { n: "1", t: "下载客户端", d: "前往下载页面获取适合你系统的版本。Windows 免安装，macOS 拖入应用程序文件夹，Linux 解压运行。", c: "#ea580c", link: "/download" },
            { n: "2", t: "输入卡密", d: "启动客户端后，在「账号卡配置」区域输入你的续杯卡密（格式为 AI...），点击「验证激活」。卡密可在 bcai.store 购买。", c: "#6366f1" },
            { n: "3", t: "一键接管", d: "在左侧「接管」面板中，选择要接管的产品（IDE / Hub / Codex / Claude Code），点击开关即可。你的 IDE 请求将自动经过本地代理。", c: "#059669" },
          ].map((s) => (
            <div key={s.n} style={{ display: "flex", gap: 16, padding: "14px 0", position: "relative" }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: `${s.c}08`, border: `1.5px solid ${s.c}18`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 18, color: s.c, flexShrink: 0, zIndex: 1 }}>
                {s.n}
              </div>
              <div style={{ paddingTop: 4 }}>
                <div style={{ fontWeight: 700, fontSize: 16, color: "#1c1917", marginBottom: 4 }}>{s.t}</div>
                <div style={{ fontSize: 14, color: "#78716c", lineHeight: 1.65 }}>{s.d}</div>
                {s.link && (
                  <a href={s.link} style={{ display: "inline-block", marginTop: 8, fontSize: 13, fontWeight: 600, color: "#ea580c", textDecoration: "none" }}>
                    前往下载 →
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* ════ 卡密说明 ════ */}
        <h2 style={sH2}>关于卡密</h2>
        <div style={{ padding: "18px 22px", borderRadius: 12, background: "#faf5ff", borderLeft: "3px solid #9333ea", margin: "0 0 20px" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "#6b21a8", marginBottom: 8 }}>💳 卡密是什么？</div>
          <div style={{ fontSize: 13, color: "#6b21a8", lineHeight: 1.7, opacity: 0.85 }}>
            卡密是你使用冰茶AI 的凭证，格式为 <code style={{ background: "rgba(147,51,234,.08)", padding: "2px 6px", borderRadius: 4, fontSize: 12 }}>AI...</code>。
            每张卡密有固定的有效期和支持的产品范围。到期后可购买新卡继续使用。
          </div>
        </div>
        <ul style={sUl}>
          <li>卡密可在 <a href="https://bcai.store" target="_blank" rel="noopener noreferrer" style={{ color: "#ea580c", fontWeight: 600, textDecoration: "none" }}>bcai.store</a> 购买</li>
          <li>激活后可在客户端查看到期时间</li>
          <li>到期前随时可输入新卡密续费，无缝衔接</li>
          <li>不同套餐支持不同的产品组合（Antigravity / Codex / Claude）</li>
        </ul>

        {/* ════ 接管说明 ════ */}
        <h2 style={sH2}>接管面板</h2>
        <p style={{ margin: "0 0 16px" }}>
          冰茶AI 支持对以下 5 个产品目标进行独立接管，每个都有独立开关：
        </p>
        <div style={{ display: "grid", gap: 0, margin: "0 0 24px" }}>
          {[
            { name: "Antigravity IDE", desc: "Gemini、Claude 双模型自动接管，体验与原生一致" },
            { name: "Antigravity Hub", desc: "Hub 内所有 AI 功能全覆盖，不影响其他功能" },
            { name: "OpenAI Codex", desc: "codex 命令直接用，自动获得 Plus/Pro 配额" },
            { name: "Claude Code", desc: "CLI、VSCode 扩展均支持，直连 Max/Pro 订阅" },
            { name: "Claude Desktop", desc: "macOS / Windows 双平台桌面端透明接管" },
          ].map((t) => (
            <div key={t.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderBottom: "1px solid rgba(0,0,0,.04)" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: "#1c1917" }}>{t.name}</div>
                <div style={{ fontSize: 12, color: "#a8a29e", marginTop: 2 }}>{t.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ════ 对比表格 ════ */}
        <h2 style={sH2}>为什么选择冰茶AI</h2>
        <div style={{ overflowX: "auto", margin: "0 0 24px", borderRadius: 12, border: "1px solid rgba(0,0,0,.06)", background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,.03)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, lineHeight: 1.6 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(0,0,0,.06)" }}>
                <th style={sTh}></th>
                <th style={{ ...sTh, color: "#ea580c", background: "rgba(234,88,12,.04)" }}>🍵 冰茶AI</th>
                <th style={{ ...sTh, color: "#78716c" }}>自行订阅</th>
                <th style={{ ...sTh, color: "#78716c" }}>API 中转</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["使用官方订阅账号", "✅", "✅", "❌ API Key"],
                ["原生速度", "✅", "✅", "❌ 可能限速"],
                ["多产品覆盖", "✅ 3 大生态", "❌ 需逐个订", "⚠️ 看中转商"],
                ["自动换号 / 封号兜底", "✅ 自动", "❌ 自负", "❌ 自负"],
                ["月均成本", "💰 低至 ¥49", "💸 $200+/产品", "💸 按量高价"],
                ["配置复杂度", "🟢 零配置", "🟡 需手动", "🔴 填 Key+改配置"],
                ["可视化用量", "✅ 仪表盘", "❌ 无", "⚠️ 看中转商"],
                ["跨平台客户端", "✅ Win/Mac/Linux", "—", "—"],
              ].map(([label, ...vals], i) => (
                <tr key={i} style={{ borderBottom: "1px solid rgba(0,0,0,.04)" }}>
                  <td style={{ ...sTd, fontWeight: 600, color: "#44403c" }}>{label}</td>
                  {vals.map((v, j) => (
                    <td key={j} style={{ ...sTd, textAlign: "center", color: j === 0 ? "#1c1917" : "#a8a29e", background: j === 0 ? "rgba(234,88,12,.02)" : undefined, fontWeight: j === 0 ? 500 : 400 }}>
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ════ CTA ════ */}
        <div style={{ padding: "24px 22px", borderRadius: 12, background: "rgba(234,88,12,.04)", border: "1px solid rgba(234,88,12,.1)", textAlign: "center" }}>
          <div style={{ fontWeight: 600, fontSize: 15, color: "#1c1917", marginBottom: 4 }}>还没有卡密？</div>
          <div style={{ fontSize: 13, color: "#78716c", marginBottom: 14 }}>前往冰茶商店购买续杯卡，多种套餐可选</div>
          <a href="https://bcai.store" target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", padding: "9px 20px", borderRadius: 8, background: "#ea580c", color: "#fff", fontWeight: 600, fontSize: 14, textDecoration: "none" }}>
            前往购买 ↗
          </a>
        </div>

      </div>
    </PublicShell>
  );
}

const sH1: React.CSSProperties = { fontSize: 30, fontWeight: 800, color: "#1c1917", letterSpacing: "-0.025em", lineHeight: 1.25, margin: "0 0 8px" };
const sSub: React.CSSProperties = { fontSize: 16, color: "#78716c", margin: "0 0 0" };
const sH2: React.CSSProperties = { fontSize: 20, fontWeight: 700, color: "#1c1917", letterSpacing: "-0.015em", margin: "48px 0 16px", lineHeight: 1.35, paddingBottom: 12, borderBottom: "1px solid rgba(0,0,0,.06)" };
const sUl: React.CSSProperties = { margin: "0 0 20px", paddingLeft: 20, listStyleType: "disc", display: "grid", gap: 6 };
const sTh: React.CSSProperties = { padding: "12px 14px", textAlign: "center", fontWeight: 650, fontSize: 13 };
const sTd: React.CSSProperties = { padding: "10px 14px", fontSize: 13 };
