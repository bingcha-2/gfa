"use client";

import { PublicShell } from "@/components/public-shell";

const hov = (e: React.MouseEvent, on: boolean) => {
  const el = e.currentTarget as HTMLElement;
  el.style.transform = on ? "translateY(-2px)" : "translateY(0)";
  el.style.boxShadow = on ? "0 8px 24px rgba(0,0,0,.06)" : "0 1px 2px rgba(0,0,0,.03)";
};

export default function HomePage() {
  return (
    <PublicShell>
      <div style={{ maxWidth: 740, padding: "52px 44px 96px", fontSize: 15, lineHeight: 1.85, color: "#57534e" }}>

        {/* ════ Hero ════ */}
        <section style={{ marginBottom: 48 }}>
          <h1 style={{ fontSize: 34, fontWeight: 800, color: "#1c1917", letterSpacing: "-0.03em", lineHeight: 1.2, margin: "0 0 10px" }}>
            冰茶AI
          </h1>
          <p style={{ fontSize: 24, fontWeight: 700, color: "#ea580c", letterSpacing: "-0.015em", lineHeight: 1.35, margin: "0 0 16px" }}>
            主流 AI 编程软件的官方账号接管工具
          </p>
          <p style={{ fontSize: 15, color: "#78716c", lineHeight: 1.75, margin: "0 0 28px", maxWidth: 540 }}>
            为你分配真实的官方订阅账号，让 Antigravity、Claude Code、Codex CLI 像往常一样直连官方。不用配 API Key、不用换工具、不用关心账号被风控。
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <a
              href="/download"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 22px", borderRadius: 9, background: "#ea580c", color: "#fff", fontWeight: 600, fontSize: 14, textDecoration: "none", boxShadow: "0 1px 3px rgba(234,88,12,.25)", transition: "all .15s" }}
              onMouseOver={(e) => { const el = e.currentTarget as HTMLElement; el.style.background = "#dc4e09"; el.style.boxShadow = "0 4px 12px rgba(234,88,12,.3)"; el.style.transform = "translateY(-1px)"; }}
              onMouseOut={(e) => { const el = e.currentTarget as HTMLElement; el.style.background = "#ea580c"; el.style.boxShadow = "0 1px 3px rgba(234,88,12,.25)"; el.style.transform = "translateY(0)"; }}
            >
              ⬇ 下载客户端
            </a>
            <a
              href="/quickstart"
              style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "10px 20px", borderRadius: 9, border: "1px solid rgba(234,88,12,.2)", background: "rgba(234,88,12,.04)", color: "#ea580c", fontWeight: 600, fontSize: 14, textDecoration: "none", transition: "all .15s" }}
              onMouseOver={(e) => { const el = e.currentTarget as HTMLElement; el.style.background = "rgba(234,88,12,.08)"; el.style.borderColor = "rgba(234,88,12,.35)"; el.style.transform = "translateY(-1px)"; }}
              onMouseOut={(e) => { const el = e.currentTarget as HTMLElement; el.style.background = "rgba(234,88,12,.04)"; el.style.borderColor = "rgba(234,88,12,.2)"; el.style.transform = "translateY(0)"; }}
            >
              快速开始 →
            </a>
            <a
              href="https://bcai.store"
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "10px 20px", borderRadius: 9, border: "1px solid rgba(0,0,0,.08)", background: "rgba(0,0,0,.02)", color: "#57534e", fontWeight: 600, fontSize: 14, textDecoration: "none", transition: "all .15s" }}
              onMouseOver={(e) => { const el = e.currentTarget as HTMLElement; el.style.background = "rgba(0,0,0,.05)"; el.style.borderColor = "rgba(0,0,0,.15)"; el.style.color = "#1c1917"; el.style.transform = "translateY(-1px)"; }}
              onMouseOut={(e) => { const el = e.currentTarget as HTMLElement; el.style.background = "rgba(0,0,0,.02)"; el.style.borderColor = "rgba(0,0,0,.08)"; el.style.color = "#57534e"; el.style.transform = "translateY(0)"; }}
            >
              💳 购买卡密 ↗
            </a>
          </div>
        </section>

        <div style={{ height: 1, background: "rgba(0,0,0,.06)", marginBottom: 48 }} />

        {/* ════ 支持的产品 ════ */}
        <h2 style={sH2}>支持的产品</h2>
        <p style={{ margin: "0 0 16px" }}>一个客户端，三个生态，开箱即用。</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, margin: "0 0 8px" }}>
          {[
            { emoji: "🔮", name: "Antigravity", sub: "IDE · Hub", color: "#6366f1", desc: "Google 旗下 AI 编程 IDE，接管后 Gemini / Claude 模型请求自动走冰茶号池。" },
            { emoji: "🧬", name: "OpenAI Codex", sub: "CLI", color: "#059669", desc: "OpenAI 的 AI 编程代理，自动获取 ChatGPT Plus/Pro 令牌，codex 命令直接用。" },
            { emoji: "🟣", name: "Claude Code", sub: "Code · Desktop", color: "#9333ea", desc: "Claude Code CLI、VSCode 扩展及 macOS 桌面端，直连 Max/Pro 订阅。" },
          ].map((p) => (
            <div
              key={p.name}
              style={{ padding: "20px 18px", borderRadius: 12, border: "1px solid rgba(0,0,0,.06)", background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,.03)", transition: "all .15s" }}
              onMouseOver={(e) => hov(e, true)} onMouseOut={(e) => hov(e, false)}
            >
              <div style={{ fontSize: 26, marginBottom: 12 }}>{p.emoji}</div>
              <div style={{ fontWeight: 700, fontSize: 14, color: p.color, marginBottom: 2 }}>{p.name}</div>
              <div style={{ fontSize: 11, color: "#a8a29e", marginBottom: 10, fontWeight: 500 }}>{p.sub}</div>
              <div style={{ fontSize: 13, color: "#78716c", lineHeight: 1.6 }}>{p.desc}</div>
            </div>
          ))}
        </div>

        {/* ════ 核心能力 ════ */}
        <h2 style={sH2}>核心能力</h2>
        <div style={{ display: "grid", gap: 0, margin: "0 0 8px" }}>
          {[
            { icon: "⚡", title: "智能号池轮换", desc: "账号额度耗尽或风控时，自动无缝切换备用账号，编程工作流不中断" },
            { icon: "🛡️", title: "封号风险隔离", desc: "单个账号风控不影响其他用户，冰茶自动移除受影响账号并补充新号" },
            { icon: "📊", title: "实时用量仪表盘", desc: "请求次数、Token 消耗、模型额度血条、已节省费用——所有数据一目了然" },
            { icon: "🔌", title: "一键接管，零配置", desc: "打开客户端 → 输入卡密 → 点击「接管」，整个过程不到 30 秒" },
          ].map((f) => (
            <div
              key={f.title}
              style={{ display: "flex", gap: 14, padding: "14px 0", borderBottom: "1px solid rgba(0,0,0,.04)", transition: "background .1s" }}
              onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(0,0,0,.01)"; }}
              onMouseOut={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              <span style={{ fontSize: 20, lineHeight: 1, paddingTop: 2, flexShrink: 0 }}>{f.icon}</span>
              <div>
                <div style={{ fontWeight: 650, fontSize: 14, color: "#1c1917", marginBottom: 2 }}>{f.title}</div>
                <div style={{ fontSize: 13, color: "#78716c", lineHeight: 1.55 }}>{f.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ════ 安全承诺 ════ */}
        <h2 style={sH2}>安全承诺</h2>
        <div style={{ padding: "18px 22px", borderRadius: 12, background: "#f0fdf4", borderLeft: "3px solid #16a34a", margin: "0 0 8px" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "#166534", marginBottom: 8 }}>🔒 你的代码不经过我们</div>
          <div style={{ fontSize: 13, color: "#166534", lineHeight: 1.7, opacity: 0.85 }}>
            <strong>不发 API Key</strong> · <strong>不修改 IDE 配置</strong> · <strong>不收集代码</strong>
            <br />
            冰茶AI 客户端运行在你的本地电脑，仅注入授权令牌。代码数据直接发送至官方服务器，我们不做中间人代理。
          </div>
        </div>

        {/* ════ 底部 CTA ════ */}
        <div
          style={{
            marginTop: 56,
            padding: "32px 28px",
            borderRadius: 14,
            background: "linear-gradient(135deg, rgba(234,88,12,.04), rgba(234,88,12,.08))",
            border: "1px solid rgba(234,88,12,.1)",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 700, color: "#1c1917", marginBottom: 6 }}>准备开始？</div>
          <div style={{ fontSize: 14, color: "#78716c", marginBottom: 18 }}>
            下载冰茶AI 客户端，输入卡密即可使用
          </div>
          <a
            href="/download"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 24px", borderRadius: 8, background: "#ea580c", color: "#fff", fontWeight: 600, fontSize: 14, textDecoration: "none", transition: "opacity .12s" }}
            onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0.9"; }}
            onMouseOut={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
          >
            ⬇ 下载客户端
          </a>
        </div>

      </div>
    </PublicShell>
  );
}

const sH2: React.CSSProperties = {
  fontSize: 20, fontWeight: 700, color: "#1c1917", letterSpacing: "-0.015em",
  margin: "48px 0 16px", lineHeight: 1.35, paddingBottom: 12, borderBottom: "1px solid rgba(0,0,0,.06)",
};
