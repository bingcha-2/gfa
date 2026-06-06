"use client";

import { PublicShell } from "@/components/public-shell";

const hov = (e: React.MouseEvent, on: boolean) => {
  const el = e.currentTarget as HTMLElement;
  el.style.transform = on ? "translateY(-2px)" : "translateY(0)";
  el.style.boxShadow = on ? "0 8px 24px rgba(0,0,0,.06)" : "0 1px 2px rgba(0,0,0,.03)";
};

export default function FeaturesPage() {
  return (
    <PublicShell>
      <div style={{ maxWidth: 740, padding: "52px 44px 96px", fontSize: 15, lineHeight: 1.85, color: "#57534e" }}>

        <h1 style={sH1}>客户端功能</h1>
        <p style={sSub}>精心设计的桌面客户端，让你全面掌控 AI 编程工具的使用状态。</p>

        {/* ════ 客户端预览 ════ */}
        <h2 style={sH2}>客户端一览</h2>
        <p style={{ margin: "0 0 16px" }}>冰茶AI 客户端是一个原生桌面应用，内置仪表盘让你随时掌握所有状态。</p>
        <div style={{ borderRadius: 14, border: "1px solid rgba(0,0,0,.08)", overflow: "hidden", boxShadow: "0 4px 24px rgba(0,0,0,.06)", margin: "0 0 8px" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/client-preview.png" alt="冰茶AI 客户端仪表盘" style={{ width: "100%", display: "block" }} />
        </div>
        <p style={{ fontSize: 12, color: "#a8a29e", textAlign: "center", margin: "8px 0 0" }}>客户端仪表盘 — 实时显示请求统计、模型用量、接管状态</p>

        {/* ════ 仪表盘 ════ */}
        <h2 style={sH2}>实时仪表盘</h2>
        <p style={{ margin: "0 0 16px" }}>打开客户端即可看到今日的完整使用概况：</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, margin: "0 0 24px" }}>
          {[
            { icon: "📈", title: "今日请求数", desc: "实时统计 AI 模型请求总量，精确到每一次调用" },
            { icon: "❌", title: "错误统计", desc: "记录请求失败次数，帮助你快速识别问题" },
            { icon: "⬆️", title: "输入 Token", desc: "统计发送给 AI 模型的 Token 数量" },
            { icon: "⬇️", title: "输出 Token", desc: "统计 AI 模型返回的 Token 数量" },
          ].map((s) => (
            <div
              key={s.title}
              style={{ padding: "18px 16px", borderRadius: 12, border: "1px solid rgba(0,0,0,.06)", background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,.03)", transition: "all .15s" }}
              onMouseOver={(e) => hov(e, true)} onMouseOut={(e) => hov(e, false)}
            >
              <div style={{ fontSize: 22, marginBottom: 10 }}>{s.icon}</div>
              <div style={{ fontWeight: 650, fontSize: 14, color: "#1c1917", marginBottom: 4 }}>{s.title}</div>
              <div style={{ fontSize: 13, color: "#78716c", lineHeight: 1.55 }}>{s.desc}</div>
            </div>
          ))}
        </div>

        {/* ════ 模型用量 ════ */}
        <h2 style={sH2}>模型用量监控</h2>
        <p style={{ margin: "0 0 16px" }}>
          客户端内置<strong style={{ color: "#1c1917" }}>实时血条</strong>显示每个模型的额度消耗情况。
          不同产品有不同的额度窗口：
        </p>
        <div style={{ display: "grid", gap: 0, margin: "0 0 24px" }}>
          {[
            { name: "Claude (Anthropic)", bars: "5 小时窗口 + 每周窗口", color: "#9333ea", desc: "双窗口独立计算，血条实时更新，显示额度重置倒计时" },
            { name: "Codex (OpenAI)", bars: "5 小时窗口 + 每周窗口", color: "#059669", desc: "与 Claude 类似的双窗口机制，精准追踪 ChatGPT Plus/Pro 配额" },
            { name: "Gemini (Google)", bars: "单一额度池", color: "#6366f1", desc: "Antigravity IDE 中的 Gemini 模型用量，显示已用/总量" },
            { name: "Claude via Antigravity", bars: "单一额度池", color: "#7c3aed", desc: "通过 Antigravity IDE 使用的 Claude 模型用量" },
          ].map((m) => (
            <div key={m.name} style={{ display: "flex", gap: 14, padding: "14px 0", borderBottom: "1px solid rgba(0,0,0,.04)" }}>
              <div style={{ width: 4, borderRadius: 2, background: m.color, flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 650, fontSize: 14, color: "#1c1917", marginBottom: 2 }}>{m.name}</div>
                <div style={{ fontSize: 12, color: m.color, fontWeight: 500, marginBottom: 4 }}>{m.bars}</div>
                <div style={{ fontSize: 13, color: "#78716c", lineHeight: 1.55 }}>{m.desc}</div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ padding: "16px 20px", borderRadius: 10, background: "#faf5ff", borderLeft: "3px solid #9333ea", margin: "0 0 8px" }}>
          <div style={{ fontSize: 13, color: "#6b21a8", lineHeight: 1.7, opacity: 0.9 }}>
            <strong>💡 额度血条还会显示重置倒计时</strong>——当额度接近用完时，你可以看到多久后额度会恢复，合理安排工作节奏。
          </div>
        </div>

        {/* ════ 接管控制 ════ */}
        <h2 style={sH2}>接管控制面板</h2>
        <p style={{ margin: "0 0 16px" }}>
          每个产品都有独立的接管开关。你可以根据需要<strong style={{ color: "#1c1917" }}>灵活选择接管哪些工具</strong>，
          不用的工具保持原生状态不受影响。
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, margin: "0 0 24px" }}>
          {[
            { name: "Antigravity IDE", icon: "🔮", status: "Gemini + Claude 双模型" },
            { name: "Antigravity Hub", icon: "🔮", status: "全部 AI 功能覆盖" },
            { name: "OpenAI Codex", icon: "🧬", status: "Plus/Pro 配额直用" },
            { name: "Claude Code", icon: "🟣", status: "CLI + VSCode 扩展" },
            { name: "Claude Desktop", icon: "🟣", status: "macOS / Windows" },
          ].map((p) => (
            <div
              key={p.name}
              style={{ padding: "16px", borderRadius: 10, border: "1px solid rgba(0,0,0,.06)", background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,.03)", display: "flex", alignItems: "center", gap: 12 }}
            >
              <span style={{ fontSize: 24 }}>{p.icon}</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: "#1c1917" }}>{p.name}</div>
                <div style={{ fontSize: 11, color: "#a8a29e" }}>{p.status}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ════ 费用追踪 ════ */}
        <h2 style={sH2}>费用追踪</h2>
        <p style={{ margin: "0 0 16px" }}>
          客户端自动计算你使用冰茶AI 相比<strong style={{ color: "#1c1917" }}>自行购买官方订阅已节省的费用</strong>。
          仪表盘上醒目的绿色数字，让你一眼看到冰茶AI 的价值。
        </p>
        <div style={{ padding: "18px 22px", borderRadius: 12, background: "#f0fdf4", borderLeft: "3px solid #16a34a", margin: "0 0 8px" }}>
          <div style={{ fontSize: 13, color: "#166534", lineHeight: 1.7, opacity: 0.85 }}>
            <strong>💰 节省金额按实际使用的模型和官方订阅价格实时计算</strong>，不夸大、不虚标。
          </div>
        </div>

        {/* ════ 更多亮点 ════ */}
        <h2 style={sH2}>更多亮点</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, margin: "0 0 24px" }}>
          {[
            { icon: "↻", title: "自动更新", desc: "内置 OTA 推送，新版本自动下载安装，无需手动操作" },
            { icon: "🌐", title: "前置代理", desc: "可配置上游 HTTP 代理，网络受限环境也能正常使用" },
            { icon: "📢", title: "公告系统", desc: "实时接收运营公告和维护通知，不错过重要信息" },
            { icon: "📋", title: "请求日志", desc: "完整记录每次 AI 请求的时间、模型、状态码，可实时查看" },
            { icon: "🔍", title: "路径检测", desc: "自动检测 IDE / Hub / Codex 安装路径，也支持手动指定" },
            { icon: "🖥️", title: "全平台覆盖", desc: "Windows · macOS (Intel + Apple Silicon) · Linux 三端原生支持" },
          ].map((h) => (
            <div
              key={h.title}
              style={{ padding: "16px 18px", borderRadius: 10, border: "1px solid rgba(0,0,0,.06)", background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,.03)", transition: "all .12s" }}
              onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,0,0,.12)"; }}
              onMouseOut={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,0,0,.06)"; }}
            >
              <span style={{ fontSize: 18, display: "block", marginBottom: 8 }}>{h.icon}</span>
              <div style={{ fontSize: 13, fontWeight: 650, color: "#1c1917", marginBottom: 4 }}>{h.title}</div>
              <div style={{ fontSize: 12.5, color: "#a8a29e", lineHeight: 1.6 }}>{h.desc}</div>
            </div>
          ))}
        </div>

        {/* ════ 设置 ════ */}
        <h2 style={sH2}>设置页面</h2>
        <p style={{ margin: "0 0 16px" }}>客户端设置页面提供以下配置选项：</p>
        <div style={{ display: "grid", gap: 0, margin: "0 0 24px" }}>
          {[
            { name: "前置代理", desc: "配置上游 HTTP/SOCKS5 代理地址，适用于需要科学上网的环境" },
            { name: "IDE 路径", desc: "Antigravity IDE 安装目录，支持自动检测或手动浏览选择" },
            { name: "Hub 路径", desc: "Antigravity Hub 安装目录，同样支持自动检测" },
            { name: "Codex 路径", desc: "Codex CLI 安装路径配置" },
          ].map((s) => (
            <div key={s.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderBottom: "1px solid rgba(0,0,0,.04)" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: "#1c1917" }}>{s.name}</div>
                <div style={{ fontSize: 12, color: "#a8a29e", marginTop: 2 }}>{s.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ════ CTA ════ */}
        <div style={{ padding: "32px 28px", borderRadius: 14, background: "linear-gradient(135deg, rgba(234,88,12,.04), rgba(234,88,12,.08))", border: "1px solid rgba(234,88,12,.1)", textAlign: "center", marginTop: 40 }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#1c1917", marginBottom: 6 }}>想亲自体验？</div>
          <div style={{ fontSize: 14, color: "#78716c", marginBottom: 18 }}>下载冰茶AI 客户端，感受这些功能</div>
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

const sH1: React.CSSProperties = { fontSize: 30, fontWeight: 800, color: "#1c1917", letterSpacing: "-0.025em", lineHeight: 1.25, margin: "0 0 8px" };
const sSub: React.CSSProperties = { fontSize: 16, color: "#78716c", margin: "0 0 0" };
const sH2: React.CSSProperties = { fontSize: 20, fontWeight: 700, color: "#1c1917", letterSpacing: "-0.015em", margin: "48px 0 16px", lineHeight: 1.35, paddingBottom: 12, borderBottom: "1px solid rgba(0,0,0,.06)" };
