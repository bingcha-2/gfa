import React, { useEffect, useState } from "react";
import type { RosettaState } from "../lib/rosetta-types";
import { onRosettaState, requestRosettaState, sendRosettaAction } from "../lib/rosetta-api";
import { RosettaAccounts } from "./rosetta-accounts";

export function RosettaPanel() {
  const [state, setState] = useState<RosettaState | null>(null);
  const [showTokenImport, setShowTokenImport] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  const [addAccountMsg, setAddAccountMsg] = useState<string | null>(null);
  const [opStatus, setOpStatus] = useState<{ operation: string; status: string } | null>(null);

  useEffect(() => {
    const unsub = onRosettaState(setState);
    requestRosettaState();
    return unsub;
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === "rosetta:operationStatus") {
        const { operation, status } = data.payload || {};
        setOpStatus(operation && status ? { operation, status } : null);
      }
      if (data?.type === "rosetta:addAccountResult") {
        setAddingAccount(false);
        if (data.payload?.error) {
          setAddAccountMsg(`失败：${data.payload.error}`);
        } else if (data.payload?.email) {
          setAddAccountMsg(`已添加 ${data.payload.email}`);
        }
        setTimeout(() => setAddAccountMsg(null), 6000);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  if (!state) {
    return <div className="rosetta-loading">Rosetta 正在连接...</div>;
  }

  if (!state.ready) {
    return (
      <div className="rosetta-not-ready">
        <p className="rosetta-problem">{state.problem || "未找到 Rosetta 代理目录"}</p>
        <p className="rosetta-hint">请确认插件内置 Rosetta 文件完整，或在设置中指定 Rosetta 目录。</p>
      </div>
    );
  }

  const { proxy, ide, relay } = state;
  const idePointsToProxy = ide.configuredUrl === proxy.url;
  const isRelayOn = Boolean(relay?.running);
  const isTakeoverOn = proxy.running && idePointsToProxy && !isRelayOn;
  const takeoverLoading = opStatus?.operation === "takeover";
  const relayLoading = opStatus?.operation === "relay";
  const anyLoading = takeoverLoading || relayLoading;
  const accessKeyStatus = relay?.accessKeyStatus || null;
  const accessKeyRemainingMs = accessKeyStatus?.expiresAt
    ? Date.parse(accessKeyStatus.expiresAt) - Date.now()
    : Number(accessKeyStatus?.remainingMs || 0);

  return (
    <div className="rosetta-root">
      <div className="rosetta-switches rosetta-switches-single">
        <SwitchCard
          label="一键接管"
          hint={
            takeoverLoading
              ? opStatus!.status === "starting" ? "正在打开..." : "正在关闭..."
              : isTakeoverOn
                ? ide.isLiveAttached ? "已接管" : "已接管，等待 IDE 生效"
                : isRelayOn
                  ? "临时续杯模式中"
                  : proxy.running
                    ? "代理运行中，IDE 未接管"
                    : "未启动"
          }
          hintDot={!takeoverLoading && isTakeoverOn}
          on={takeoverLoading ? opStatus!.status === "starting" : isTakeoverOn}
          loading={takeoverLoading}
          disabled={anyLoading}
          onClick={() => sendRosettaAction("rosetta:toggleTakeover")}
        />
      </div>
      <p className="rosetta-takeover-desc">
        <strong>开启一键接管后插件会自动选择最优账号进行对话</strong>
      </p>

      <div className="rosetta-relay-section">
        <div className="rosetta-switches rosetta-switches-single">
          <SwitchCard
            label="临时续杯"
            hint={
              relayLoading
                ? opStatus!.status === "starting" ? "正在打开..." : "正在关闭..."
                : isRelayOn
                  ? `运行中 · ${relay.totalRequests} 请求`
                  : !relay?.hasApiKey
                    ? "未配置卡密"
                    : "未开启"
            }
            hintDot={!relayLoading && isRelayOn}
            on={relayLoading ? opStatus!.status === "starting" : isRelayOn}
            loading={relayLoading}
            disabled={anyLoading}
            onClick={() => sendRosettaAction("rosetta:toggleRelay")}
          />
        </div>
        <div className="rosetta-actions" style={{ marginTop: 4 }}>
          <button className="rosetta-btn" onClick={() => sendRosettaAction("rosetta:setRelayKey")}>
            设置卡密
          </button>
        </div>

        {isRelayOn && (
          <div className="rosetta-status-banner" style={{ marginTop: 6 }}>
            <div className="rosetta-status-right" style={{ width: "100%", justifyContent: "center", flexWrap: "wrap" }}>
              <span className="rosetta-status-stat">
                <span className="rosetta-status-stat-val">{relay.totalRequests}</span> 请求
              </span>
              <span className="rosetta-status-sep">·</span>
              <span className="rosetta-status-stat">
                <span className="rosetta-status-stat-val">
                  {(relay.totalInputTokens + relay.totalOutputTokens).toLocaleString()}
                </span>{" "}
                tokens
              </span>
              {relay.totalErrors > 0 && (
                <>
                  <span className="rosetta-status-sep">·</span>
                  <span className="rosetta-status-stat bad">
                    <span className="rosetta-status-stat-val">{relay.totalErrors}</span> 错误
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        {isRelayOn && (
          <div className="rosetta-status-banner" style={{ marginTop: 6 }}>
            <div className="rosetta-status-right" style={{ width: "100%", justifyContent: "center", flexWrap: "wrap" }}>
              {accessKeyStatus ? (
                <>
                  <span className={`rosetta-status-stat ${accessKeyRemainingMs > 0 ? "good" : "bad"}`}>
                    卡密剩余 <span className="rosetta-status-stat-val">{formatDurationShort(accessKeyRemainingMs)}</span>
                  </span>
                  <span className="rosetta-status-sep">·</span>
                  <span className="rosetta-status-stat">
                    5小时{" "}
                    <span className="rosetta-status-stat-val">
                      {accessKeyStatus.recentWindowRequests}/{accessKeyStatus.windowLimit}
                    </span>
                  </span>
                  <span className="rosetta-status-sep">·</span>
                  <span className="rosetta-status-stat">
                    总请求 <span className="rosetta-status-stat-val">{accessKeyStatus.totalRequests}</span>
                  </span>
                </>
              ) : (
                <span className="rosetta-status-stat">
                  卡密状态 <span className="rosetta-status-stat-val">等待首次租约</span>
                </span>
              )}
            </div>
          </div>
        )}

        {relay?.lastError && (
          <div
            className="rosetta-hint"
            style={{ padding: "4px 10px", borderRadius: 8, background: "rgba(239,68,68,0.08)", fontSize: 11, marginTop: 4 }}
          >
            {relay.lastError}
          </div>
        )}
      </div>

      {proxy.running && (
        <div className="rosetta-status-banner">
          <div className="rosetta-status-right" style={{ width: "100%", justifyContent: "center" }}>
            <span className="rosetta-status-account">{proxy.activeEmail?.split("@")[0] || "-"}</span>
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
              <span className="rosetta-status-stat-val">
                {proxy.rotatableAccounts}/{proxy.totalAccounts}
              </span>{" "}
              可用
            </span>
          </div>
        </div>
      )}

      <div className="rosetta-actions">
        <button
          className="rosetta-btn"
          disabled={addingAccount}
          onClick={() => {
            setAddingAccount(true);
            setAddAccountMsg("浏览器已打开，请完成 Google 登录...");
            sendRosettaAction("rosetta:addAccount");
          }}
        >
          {addingAccount ? "等待登录..." : "新增账号"}
        </button>
        <button className="rosetta-btn" onClick={() => setShowTokenImport(!showTokenImport)}>
          {showTokenImport ? "取消" : "Token 导入"}
        </button>
        <button className="rosetta-btn" onClick={() => sendRosettaAction("rosetta:refreshQuota")}>
          刷新
        </button>
      </div>

      {addAccountMsg && (
        <div className="rosetta-hint" style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(234,88,12,0.08)", fontSize: 12 }}>
          {addAccountMsg}
        </div>
      )}

      {showTokenImport && (
        <TokenImportForm onDone={() => { setShowTokenImport(false); sendRosettaAction("rosetta:refresh"); }} />
      )}

      <RosettaAccounts accounts={state.accounts} proxyRunning={proxy.running} />
    </div>
  );
}

function formatDurationShort(ms?: number | null) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (!total) return "已到期";
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  return `${Math.max(1, m)}分`;
}

function TokenImportForm({ onDone }: { onDone: () => void }) {
  const [refreshToken, setRefreshToken] = useState("");
  const [alias, setAlias] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const token = refreshToken.trim();
    if (!token) {
      setError("请输入 Refresh Token");
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === "rosetta:addAccountResult") {
        setLoading(false);
        window.removeEventListener("message", handler);
        if (data.payload?.error) {
          setError(data.payload.error);
        } else {
          setSuccess(`已添加账号 ${data.payload?.email || ""}`);
          setRefreshToken("");
          setAlias("");
          setTimeout(() => onDone(), 1500);
        }
      }
    };
    window.addEventListener("message", handler);
    sendRosettaAction("rosetta:addAccountToken", { refreshToken: token, alias: alias.trim() });
  }

  return (
    <div className="rosetta-add-form">
      <div className="rosetta-add-form-title">Token 导入</div>
      <p className="rosetta-add-form-hint">
        适用于已有 Refresh Token 的用户。一般直接点“新增账号”通过浏览器登录即可。
      </p>
      <form onSubmit={handleSubmit}>
        <div className="rosetta-form-field">
          <label className="rosetta-form-label">Refresh Token</label>
          <textarea
            className="rosetta-form-input rosetta-form-textarea"
            placeholder="粘贴 Google OAuth Refresh Token..."
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
        <button className="rosetta-btn rosetta-btn-primary" type="submit" disabled={loading || !refreshToken.trim()}>
          {loading ? "正在验证..." : "导入并获取额度"}
        </button>
      </form>
    </div>
  );
}

function SwitchCard({
  label, hint, hintDot, on, onClick, loading, disabled,
}: {
  label: string;
  hint: string;
  hintDot?: boolean;
  on: boolean;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  const cls = [
    "rosetta-switch",
    on ? "on" : "off",
    loading ? "loading" : "",
    disabled ? "disabled" : "",
  ].filter(Boolean).join(" ");

  return (
    <button className={cls} onClick={disabled ? undefined : onClick} disabled={disabled}>
      <span className="rosetta-switch-copy">
        <span className="rosetta-switch-label">{label}</span>
        <span className="rosetta-switch-hint">
          {loading && <span className="rosetta-spinner-inline" />}
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
