import { PublicShell } from "@/components/public-shell";

export const metadata = {
  title: "工作原理 — 冰茶AI",
  description: "冰茶AI 在你电脑和官方 API 之间做了什么：本地代理注入令牌，直连官方服务器，不做中间人。",
};

export default function HowItWorksPage() {
  return (
    <PublicShell>
      <div style={{ maxWidth: 740, padding: "52px 44px 96px", fontSize: 15, lineHeight: 1.85, color: "#57534e" }}>

        <h1 style={sH1}>工作原理</h1>
        <p style={sSub}>冰茶AI 在你电脑和官方 API 之间做了什么。</p>

        {/* ════ 架构概述 ════ */}
        <h2 style={sH2}>架构概述</h2>
        <p style={{ margin: "0 0 16px" }}>
          冰茶AI 在你的电脑上运行一个<strong style={{ color: "#1c1917" }}>轻量级本地代理</strong>。
          它不是一个云端中转服务——你的代码和 AI 对话数据<strong style={{ color: "#1c1917" }}>不经过我们的服务器</strong>，
          而是直接发送至 Google、OpenAI、Anthropic 的官方 API 端点。
        </p>
        <div style={{ padding: "18px 22px", borderRadius: 12, background: "#eff6ff", borderLeft: "3px solid #3b82f6", margin: "0 0 20px" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "#1e40af", marginBottom: 6 }}>💡 核心理念</div>
          <div style={{ fontSize: 13, color: "#1e40af", lineHeight: 1.7, opacity: 0.85 }}>
            冰茶AI 只做一件事：为你的 IDE 请求注入正确的官方订阅令牌。<br />
            不修改请求内容、不缓存响应、不记录代码——纯粹的令牌注入层。
          </div>
        </div>

        {/* ════ 4 步流程 ════ */}
        <h2 style={sH2}>请求生命周期</h2>
        <p style={{ margin: "0 0 16px" }}>当你在 IDE 中发起一次 AI 请求时，会经历以下四个步骤：</p>
        <div style={{ position: "relative", margin: "0 0 24px" }}>
          <div style={{ position: "absolute", left: 23, top: 32, bottom: 32, width: 2, background: "linear-gradient(180deg, #ea580c 0%, #6366f1 35%, #059669 70%, #d97706 100%)", opacity: 0.1, borderRadius: 1 }} />
          {[
            { n: "1", t: "拦截请求", d: "本地代理透明拦截 IDE 发往官方的 HTTPS 请求", c: "#ea580c" },
            { n: "2", t: "注入令牌", d: "从号池获取一个可用账号的令牌，注入到请求的 Authorization / Cookie 头", c: "#6366f1" },
            { n: "3", t: "直达官方", d: "带有正确令牌的请求直接发送至 Google / OpenAI / Anthropic 官方 API 服务器", c: "#059669" },
            { n: "4", t: "返回结果", d: "官方的 AI 响应原路返回你的 IDE，体验与原生订阅完全一致", c: "#d97706" },
          ].map((s) => (
            <div key={s.n} style={{ display: "flex", gap: 16, padding: "12px 0", position: "relative" }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: `${s.c}08`, border: `1.5px solid ${s.c}18`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 18, color: s.c, flexShrink: 0, zIndex: 1 }}>
                {s.n}
              </div>
              <div style={{ paddingTop: 4 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#1c1917", marginBottom: 3 }}>{s.t}</div>
                <div style={{ fontSize: 14, color: "#78716c", lineHeight: 1.6 }}>{s.d}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ════ 号池轮换 ════ */}
        <h2 style={sH2}>号池轮换机制</h2>
        <p style={{ margin: "0 0 16px" }}>
          冰茶AI 后台维护着一个真实官方订阅账号的号池。你的客户端通过「租号」机制动态获取可用账号：
        </p>
        <div style={{ display: "grid", gap: 0, margin: "0 0 24px" }}>
          {[
            { icon: "🔄", title: "自动续租", desc: "令牌有效期内自动续租，到期前无缝切换到新令牌" },
            { icon: "⚠️", title: "额度耗尽", desc: "当前账号额度用完后，自动切换到号池中其他有余量的账号" },
            { icon: "🚫", title: "风控处理", desc: "账号被平台风控时，自动标记不可用并从号池移除，不影响其他用户" },
            { icon: "➕", title: "自动补充", desc: "运维团队持续补充新账号到号池，确保可用账号数量充足" },
          ].map((f) => (
            <div key={f.title} style={{ display: "flex", gap: 14, padding: "14px 0", borderBottom: "1px solid rgba(0,0,0,.04)" }}>
              <span style={{ fontSize: 18, lineHeight: 1, paddingTop: 2, flexShrink: 0 }}>{f.icon}</span>
              <div>
                <div style={{ fontWeight: 650, fontSize: 14, color: "#1c1917", marginBottom: 2 }}>{f.title}</div>
                <div style={{ fontSize: 13, color: "#78716c", lineHeight: 1.55 }}>{f.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ════ 各产品接管体验 ════ */}
        <h2 style={sH2}>各产品接管体验</h2>
        <p style={{ margin: "0 0 16px" }}>
          每款产品都经过专门适配，实现<strong style={{ color: "#1c1917" }}>一键接管、无感使用</strong>：
        </p>

        {[
          {
            name: "Antigravity IDE",
            color: "#6366f1",
            highlights: ["Gemini、Claude 双模型自动接管", "IDE 内使用体验与原生订阅完全一致", "退出接管后自动恢复原始状态"],
          },
          {
            name: "Antigravity Hub",
            color: "#6366f1",
            highlights: ["Hub 内所有 AI 功能自动走冰茶号池", "深度适配，覆盖全部网络请求", "不影响其他 Hub 功能的正常使用"],
          },
          {
            name: "OpenAI Codex CLI",
            color: "#059669",
            highlights: ["codex 命令直接用，无需手动获取令牌", "自动获得 ChatGPT Plus/Pro 订阅配额", "与官方 CLI 体验完全一致"],
          },
          {
            name: "Claude Code",
            color: "#9333ea",
            highlights: ["支持 CLI、VSCode 扩展等多种使用方式", "不修改 Claude 的任何配置文件", "直连 Max/Pro 订阅额度"],
          },
          {
            name: "Claude Desktop",
            color: "#9333ea",
            highlights: ["支持 macOS 和 Windows 双平台", "桌面端请求透明接管，无感使用", "退出接管自动清理，恢复原始状态"],
          },
        ].map((p) => (
          <div
            key={p.name}
            style={{
              padding: "18px 20px",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,.06)",
              background: "#fff",
              marginBottom: 12,
              boxShadow: "0 1px 2px rgba(0,0,0,.03)",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14, color: p.color, marginBottom: 10 }}>{p.name}</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#78716c", lineHeight: 1.8 }}>
              {p.highlights.map((h) => <li key={h}>{h}</li>)}
            </ul>
          </div>
        ))}

        {/* ════ 安全模型 ════ */}
        <h2 style={sH2}>安全模型</h2>
        <div style={{ padding: "18px 22px", borderRadius: 12, background: "#f0fdf4", borderLeft: "3px solid #16a34a", margin: "0 0 20px" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "#166534", marginBottom: 8 }}>🔒 我们的安全承诺</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#166534", lineHeight: 1.8, opacity: 0.85 }}>
            <li><strong>不发 API Key</strong> — 使用官方订阅额度，不是 API 转发</li>
            <li><strong>不修改 IDE 配置</strong> — 接管退出后自动恢复原始配置</li>
            <li><strong>不收集代码</strong> — 本地代理仅注入令牌，代码直达官方</li>
            <li><strong>不做中间人</strong> — 请求数据不经过冰茶服务器</li>
          </ul>
        </div>

      </div>
    </PublicShell>
  );
}

const sH1: React.CSSProperties = { fontSize: 30, fontWeight: 800, color: "#1c1917", letterSpacing: "-0.025em", lineHeight: 1.25, margin: "0 0 8px" };
const sSub: React.CSSProperties = { fontSize: 16, color: "#78716c", margin: "0 0 0" };
const sH2: React.CSSProperties = { fontSize: 20, fontWeight: 700, color: "#1c1917", letterSpacing: "-0.015em", margin: "48px 0 16px", lineHeight: 1.35, paddingBottom: 12, borderBottom: "1px solid rgba(0,0,0,.06)" };
