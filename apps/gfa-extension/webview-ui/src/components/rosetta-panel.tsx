import React, { useEffect, useState } from "react";
import type { RosettaState } from "../lib/rosetta-types";
import { onRosettaState, sendRosettaAction, requestRosettaState } from "../lib/rosetta-api";
import { RosettaAccounts } from "./rosetta-accounts";

/**
 * Main Rosetta panel — system pulse, service switches, account pool.
 * Renders as stacked sections inside the existing BCAI sidebar.
 */
export function RosettaPanel() {
  const [state, setState] = useState<RosettaState | null>(null);
  const [showTokenImport, setShowTokenImport] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  const [addAccountMsg, setAddAccountMsg] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onRosettaState(setState);
    requestRosettaState();
    return unsub;
  }, []);

  // Listen for browser OAuth result
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === "rosetta:addAccountResult") {
        setAddingAccount(false);
        if (data.payload?.error) {
          setAddAccountMsg(`❌ ${data.payload.error}`);
        } else if (data.payload?.email) {
          setAddAccountMsg(`✅ 已添加 ${data.payload.email}`);
        }
        setTimeout(() => setAddAccountMsg(null), 6000);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  if (!state) {
    return <div className="rosetta-loading">Rosetta 正在连接…</div>;
  }

  if (!state.ready) {
    return (
      <div className="rosetta-not-ready">
        <p className="rosetta-problem">{state.problem || "未找到 Rosetta 代理目录"}</p>
        <p className="rosetta-hint">请确认 Antigravity-Rosetta 已放到桌面或工作区同级目录。</p>
      </div>
    );
  }

  const { proxy, ide } = state;
  const isTakeoverOn = proxy.running && ide.isConfigured;

  return (
    <div className="rosetta-root">
      {/* ─── One-click Takeover (top) ─── */}
      <div className="rosetta-switches rosetta-switches-single">
        <SwitchCard
          label="一键接管"
          hint={
            isTakeoverOn
              ? (ide.isLiveAttached ? "已接管 ✓" : "已接管 · 待 IDE 重启")
              : proxy.running
                ? "代理运行中 · IDE 未接管"
                : "未启动"
          }
          hintDot={isTakeoverOn}
          on={isTakeoverOn}
          onClick={() => sendRosettaAction("rosetta:toggleTakeover")}
        />
      </div>
      <p className="rosetta-takeover-desc"><strong>开启一键接管后插件会自动选择最优账号进行对话</strong></p>

      {/* ─── Stats Row (only when proxy running) ─── */}
      {proxy.running && (
        <div className="rosetta-status-banner">
          <div className="rosetta-status-right" style={{ width: '100%', justifyContent: 'center' }}>
            <span className="rosetta-status-account">{proxy.activeEmail?.split("@")[0] || "—"}</span>
            <span className="rosetta-status-sep">·</span>
            <span className="rosetta-status-stat">
              <span className="rosetta-status-stat-val">{proxy.totalRequests}</span> 请求
            </span>
            <span className="rosetta-status-sep">·</span>
            <span className="rosetta-status-stat">
              <span className="rosetta-status-stat-val">{proxy.totalRotations}</span> 切换
            </span>
            <span className="rosetta-status-sep">·</span>
            <span className={`rosetta-status-stat ${proxy.rotatableAccounts > 0 ? "good" : "bad"}`}>
              <span className="rosetta-status-stat-val">{proxy.rotatableAccounts}/{proxy.totalAccounts}</span> 可用
            </span>
          </div>
        </div>
      )}

      {/* ─── Quick Actions ─── */}
      <div className="rosetta-actions">
        <button
          className="rosetta-btn"
          disabled={addingAccount}
          onClick={() => {
            setAddingAccount(true);
            setAddAccountMsg("🌐 浏览器已打开，请完成 Google 登录…");
            sendRosettaAction("rosetta:addAccount");
          }}
        >
          {addingAccount ? "⏳ 等待登录…" : "➕ 新增账号"}
        </button>
        <button className="rosetta-btn" onClick={() => setShowTokenImport(!showTokenImport)}>
          {showTokenImport ? "✕ 取消" : "📋 Token 导入"}
        </button>
        <button className="rosetta-btn" onClick={() => sendRosettaAction("rosetta:refreshQuota")}>🔄 刷新</button>
      </div>

      {/* ─── Browser OAuth status message ─── */}
      {addAccountMsg && (
        <div className="rosetta-hint" style={{ padding: '6px 10px', borderRadius: 8, background: addAccountMsg.startsWith('✅') ? 'rgba(34,197,94,0.08)' : addAccountMsg.startsWith('❌') ? 'rgba(239,68,68,0.08)' : 'rgba(234,88,12,0.08)', fontSize: 12 }}>
          {addAccountMsg}
        </div>
      )}

      {/* ─── Token Import Form (advanced) ─── */}
      {showTokenImport && (
        <TokenImportForm onDone={() => { setShowTokenImport(false); sendRosettaAction("rosetta:refresh"); }} />
      )}

      {/* ─── Account Pool ─── */}
      <RosettaAccounts accounts={state.accounts} proxyRunning={proxy.running} />
    </div>
  );
}

// ─── Token Import Form (advanced users) ─────────────────────────────────

function TokenImportForm({ onDone }: { onDone: () => void }) {
  const [refreshToken, setRefreshToken] = useState("");
  const [alias, setAlias] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const token = refreshToken.trim();
    if (!token) { setError("请输入 Refresh Token"); return; }

    setLoading(true);
    setError(null);
    setSuccess(null);

    sendRosettaAction("rosetta:addAccountToken", {
      refreshToken: token,
      alias: alias.trim(),
    });

    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === "rosetta:addAccountResult") {
        window.removeEventListener("message", handler);
        setLoading(false);
        if (data.payload?.error) {
          setError(data.payload.error);
        } else {
          setSuccess(`✓ 已添加账号 ${data.payload?.email || ""}`);
          setRefreshToken("");
          setAlias("");
          setTimeout(() => onDone(), 1500);
        }
      }
    };
    window.addEventListener("message", handler);

    setTimeout(() => {
      window.removeEventListener("message", handler);
      setLoading(false);
    }, 30000);
  }

  return (
    <div className="rosetta-add-form">
      <div className="rosetta-add-form-title">Token 导入（高级）</div>
      <p className="rosetta-add-form-hint">
        适用于已有 Refresh Token 的用户。一般直接点「新增账号」通过浏览器登录即可。
      </p>
      <form onSubmit={handleSubmit}>
        <div className="rosetta-form-field">
          <label className="rosetta-form-label">Refresh Token</label>
          <textarea
            className="rosetta-form-input rosetta-form-textarea"
            placeholder="粘贴 Google OAuth Refresh Token…"
            value={refreshToken}
            onChange={(e) => setRefreshToken(e.target.value)}
            rows={3}
            disabled={loading}
          />
        </div>
        <div className="rosetta-form-field">
          <label className="rosetta-form-label">别名（可选）</label>
          <input
            className="rosetta-form-input"
            placeholder="例如：主号、备用号"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            disabled={loading}
          />
        </div>
        {error && <div className="rosetta-form-error">{error}</div>}
        {success && <div className="rosetta-form-success">{success}</div>}
        <button
          className="rosetta-btn rosetta-btn-primary"
          type="submit"
          disabled={loading || !refreshToken.trim()}
        >
          {loading ? "正在验证…" : "导入并获取额度"}
        </button>
      </form>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────

function PulseDot({ on, warn, label }: { on: boolean; warn?: boolean; label: string }) {
  const cls = on ? "on" : warn ? "warn" : "off";
  return (
    <span className={`rosetta-pulse-item`}>
      <span className={`rosetta-dot ${cls}`} />
      <span className="rosetta-dot-label">{label}</span>
    </span>
  );
}


function SwitchCard({
  label, hint, hintDot, on, onClick,
}: {
  label: string; hint: string; hintDot?: boolean; on: boolean; onClick: () => void;
}) {
  return (
    <button className={`rosetta-switch ${on ? "on" : "off"}`} onClick={onClick}>
      <span className="rosetta-switch-copy">
        <span className="rosetta-switch-label">{label}</span>
        <span className="rosetta-switch-hint">
          {hintDot && <span className="rosetta-dot on rosetta-dot-inline" />}
          {hint}
        </span>
      </span>
      <span className="rosetta-switch-track">
        <span className="rosetta-switch-thumb" />
      </span>
    </button>
  );
}
