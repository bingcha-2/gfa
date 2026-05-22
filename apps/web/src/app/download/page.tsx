"use client";

export default function DownloadPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 20px",
        background: "linear-gradient(145deg, #0c0a15 0%, #1a1333 40%, #0f172a 100%)",
        fontFamily: "var(--font-sans), system-ui, sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 640,
          display: "flex",
          flexDirection: "column",
          gap: 32,
        }}
      >
        {/* Header */}
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 64,
              height: 64,
              borderRadius: 16,
              background: "linear-gradient(135deg, #ea580c, #f97316)",
              marginBottom: 20,
              fontSize: 32,
            }}
          >
            🍵
          </div>
          <h1
            style={{
              fontSize: 32,
              fontWeight: 800,
              background: "linear-gradient(90deg, #f97316, #fb923c, #fbbf24)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              margin: "0 0 8px",
              letterSpacing: "-0.02em",
            }}
          >
            冰茶AI 客户端
          </h1>
          <p
            style={{
              color: "rgba(255,255,255,.55)",
              fontSize: 15,
              margin: 0,
              lineHeight: 1.6,
            }}
          >
            一键续杯，无需 IDE 插件。下载安装后输入卡密即可使用。
          </p>
        </div>

        {/* Download Cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 16,
          }}
        >
          {/* Windows */}
          <a
            href="/updates/BingchaAI-Setup-latest.exe"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 14,
              padding: "28px 20px",
              borderRadius: 16,
              border: "1px solid rgba(99,102,241,.3)",
              background: "rgba(99,102,241,.08)",
              textDecoration: "none",
              transition: "all .2s",
              cursor: "pointer",
            }}
            onMouseOver={(e) => {
              (e.currentTarget as HTMLElement).style.background = "rgba(99,102,241,.15)";
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(99,102,241,.5)";
              (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)";
            }}
            onMouseOut={(e) => {
              (e.currentTarget as HTMLElement).style.background = "rgba(99,102,241,.08)";
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(99,102,241,.3)";
              (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
            }}
          >
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M3 5.548l7.065-0.96v6.825H3V5.548zm0 12.9l7.065 0.967V12.58H3v5.868zm7.834 1.073L21 20.998V12.58H10.834v6.941zm0-14.046v7.092H21V3L10.834 5.475z" fill="#818cf8"/>
            </svg>
            <div style={{ textAlign: "center" }}>
              <div style={{ color: "#c7d2fe", fontWeight: 700, fontSize: 16, marginBottom: 4 }}>
                Windows
              </div>
              <div style={{ color: "rgba(255,255,255,.4)", fontSize: 12 }}>
                Windows 10 / 11 (64-bit)
              </div>
            </div>
            <div
              style={{
                padding: "8px 24px",
                borderRadius: 8,
                background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                color: "#fff",
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              ⬇ 立即下载
            </div>
          </a>

          {/* macOS */}
          <a
            href="/updates/BingchaAI-Setup-latest.dmg"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 14,
              padding: "28px 20px",
              borderRadius: 16,
              border: "1px solid rgba(255,255,255,.12)",
              background: "rgba(255,255,255,.04)",
              textDecoration: "none",
              transition: "all .2s",
              cursor: "pointer",
            }}
            onMouseOver={(e) => {
              (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,.08)";
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,.2)";
              (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)";
            }}
            onMouseOut={(e) => {
              (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,.04)";
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,.12)";
              (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
            }}
          >
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M18.71 19.5C17.88 20.74 17 21.95 15.66 21.97C14.32 22 13.89 21.18 12.37 21.18C10.84 21.18 10.37 21.95 9.1 22C7.79 22.05 6.8 20.68 5.96 19.47C4.25 16.56 2.93 11.3 4.7 7.72C5.57 5.94 7.36 4.86 9.28 4.84C10.56 4.82 11.78 5.72 12.56 5.72C13.34 5.72 14.82 4.62 16.38 4.8C17.05 4.83 18.87 5.08 20.06 6.82C19.93 6.9 17.69 8.2 17.72 10.92C17.75 14.17 20.54 15.23 20.57 15.24C20.54 15.32 20.12 16.82 19.05 18.36L18.71 19.5ZM13 3.5C13.73 2.67 14.94 2.04 15.94 2C16.07 3.17 15.58 4.35 14.89 5.19C14.21 6.04 13.07 6.7 11.95 6.61C11.8 5.46 12.39 4.26 13 3.5Z" fill="#9ca3af"/>
            </svg>
            <div style={{ textAlign: "center" }}>
              <div style={{ color: "rgba(255,255,255,.7)", fontWeight: 700, fontSize: 16, marginBottom: 4 }}>
                macOS
              </div>
              <div style={{ color: "rgba(255,255,255,.35)", fontSize: 12 }}>
                Intel & Apple Silicon
              </div>
            </div>
            <div
              style={{
                padding: "8px 24px",
                borderRadius: 8,
                background: "rgba(255,255,255,.1)",
                color: "rgba(255,255,255,.6)",
                fontWeight: 600,
                fontSize: 14,
                border: "1px solid rgba(255,255,255,.1)",
              }}
            >
              ⬇ 立即下载
            </div>
          </a>
        </div>

        {/* Info */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: "20px 24px",
            borderRadius: 12,
            background: "rgba(255,255,255,.03)",
            border: "1px solid rgba(255,255,255,.08)",
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: 14,
              fontWeight: 700,
              color: "rgba(255,255,255,.7)",
            }}
          >
            使用说明
          </h3>
          <div style={{ display: "grid", gap: 8, fontSize: 13, color: "rgba(255,255,255,.45)", lineHeight: 1.6 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span style={{ color: "#f97316", fontWeight: 700, flexShrink: 0 }}>1.</span>
              <span>下载安装后打开客户端，输入您的续杯卡密</span>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span style={{ color: "#f97316", fontWeight: 700, flexShrink: 0 }}>2.</span>
              <span>点击「开启续杯」，客户端会自动配置 IDE 连接</span>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span style={{ color: "#f97316", fontWeight: 700, flexShrink: 0 }}>3.</span>
              <span>在 Cursor / Windsurf 等 IDE 中正常使用即可，无需安装插件</span>
            </div>
          </div>
          <div
            style={{
              marginTop: 4,
              padding: "10px 14px",
              borderRadius: 8,
              background: "rgba(34,197,94,.06)",
              border: "1px solid rgba(34,197,94,.15)",
              fontSize: 12,
              color: "rgba(34,197,94,.7)",
            }}
          >
            ✅ 客户端支持自动更新，安装后无需手动升级。卡密等配置数据在升级时自动保留。
          </div>
        </div>

        {/* Footer link */}
        <div style={{ textAlign: "center" }}>
          <a
            href="/"
            style={{
              color: "rgba(255,255,255,.35)",
              fontSize: 13,
              textDecoration: "none",
            }}
          >
            ← 返回首页
          </a>
        </div>
      </div>
    </main>
  );
}
