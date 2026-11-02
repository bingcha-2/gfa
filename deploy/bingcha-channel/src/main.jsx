import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  CaretLeft,
  CaretRight,
  CheckCircle,
  Cloud,
  CloudArrowUp,
  Coins,
  Copy,
  Crosshair,
  DownloadSimple,
  Eye,
  EyeSlash,
  GlobeHemisphereWest,
  Key,
  Lightning,
  ListMagnifyingGlass,
  LockKey,
  MagnifyingGlass,
  Moon,
  Power,
  Robot,
  RocketLaunch,
  ShieldCheck,
  SignOut,
  Sun,
  UploadSimple,
  UserPlus,
  UsersThree,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import "./app.css";

const appBase = new URL(".", window.location.href);

function endpoint(path) {
  return new URL(String(path).replace(/^\/+/, ""), appBase).toString();
}

async function request(path, options = {}) {
  const response = await fetch(endpoint(path), {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.detail || "请求失败");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function consumeSse(response, onEvent) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || "上游请求失败");
  }
  if (!response.body) throw new Error("上游没有返回数据");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line.startsWith("data: ")) continue;
      try {
        onEvent(JSON.parse(line.slice(6)));
      } catch {
        // Ignore malformed upstream progress frames while keeping the stream alive.
      }
    }
  }
}

function countKeys(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean).length;
}

function maskKey(value) {
  const key = String(value || "");
  if (key.length <= 24) return key || "未知 Key";
  return `${key.slice(0, 10)}...${key.slice(-8)}`;
}

function keySuffix(value) {
  return String(value || "").trim().slice(-8).toLowerCase();
}

function localRecordedAt(backupTimes, key) {
  const value = String(key || "");
  return (
    backupTimes[`full:${value}`] ||
    backupTimes[`suffix:${keySuffix(value)}`] ||
    null
  );
}

function indexKeyMetadata(records) {
  const indexed = {};
  for (const record of records || []) {
    const suffix = keySuffix(record.key);
    if (!suffix) continue;
    if (!(suffix in indexed)) {
      indexed[suffix] = record;
    } else {
      indexed[suffix] = null;
    }
  }
  return indexed;
}

function metadataForKey(indexed, key) {
  return indexed[keySuffix(key)] || null;
}

function stageLabel(stage, waitSeconds) {
  const labels = {
    queue: waitSeconds == null ? "正在排队" : `排队中，预计 ${waitSeconds} 秒`,
    probe: "正在检测可用性",
    upload: "正在写入渠道",
    uploaded: "已完成当前密钥",
    probe_failed: "检测失败",
    upload_failed: "写入失败",
  };
  return labels[stage] || "正在处理";
}

function statusTone(status) {
  if (status === "正常") return "success";
  if (status === "未知") return "neutral";
  return "danger";
}

function usageRange(item) {
  if (item.usage_lte_1 === true) return "不足 1 美元";
  if (item.usage_lte_5 === true) return "不足 5 美元";
  if (item.usage_lte_10 === true) return "不足 10 美元";
  if (item.usage_lte_15 === true) return "不足 15 美元";
  if (item.usage_lte_20 === true) return "不足 20 美元";
  if (item.usage_lte_20 === false) return "大于 20 美元";
  return "用量未知";
}

function Brand({ compact = false }) {
  return (
    <div className={`brand${compact ? " brand--compact" : ""}`}>
      <img
        src="https://bcai.online/assets/bingcha-ai-logo.png"
        alt="冰茶 AI"
        className="brand__mark"
      />
      <span className="brand__copy">
        <strong>冰茶</strong>
        <small>渠道管理</small>
      </span>
    </div>
  );
}

function formatGapMetric(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(number);
}

function TrafficGapStatus() {
  const [data, setData] = useState(null);

  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        const response = await request("api/traffic-gaps");
        if (active) setData(response);
      } catch {
        // Keep the last successful reading during a temporary upstream outage.
      }
    }

    refresh();
    const timer = window.setInterval(refresh, 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div
      className="traffic-gap-status"
      aria-label="最近一分钟全局流量缺口"
      title={`统计站点：${data?.successful_site_count ?? "--"}/${data?.site_count ?? "--"}`}
    >
      <div className="traffic-gap-status__metric">
        <span>RPM 缺口</span>
        <strong>{formatGapMetric(data?.rpm_gap)}</strong>
      </div>
      <div className="traffic-gap-status__metric">
        <span>TPM 缺口</span>
        <strong>{formatGapMetric(data?.tpm_gap)}</strong>
      </div>
      <small className="traffic-gap-status__updated">
        更新 {data?.updated_at || "--"}{data?.stale ? " · 缓存" : ""}
      </small>
    </div>
  );
}

function ThemeButton({ theme, onChange }) {
  const nextTheme = theme === "dark" ? "light" : "dark";
  return (
    <button
      className="icon-button"
      type="button"
      aria-label={nextTheme === "dark" ? "切换到深色模式" : "切换到浅色模式"}
      title={nextTheme === "dark" ? "深色模式" : "浅色模式"}
      onClick={() => onChange(nextTheme)}
    >
      {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

function LoginScreen({ onLogin, theme, onThemeChange }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const response = await request("api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      setPassword("");
      onLogin(response.data);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-brand" aria-label="冰茶渠道控制台">
        <div className="login-brand__inner">
          <Brand />
          <div className="login-brand__statement">
            <span className="temperature">0°C</span>
            <h1>管理渠道密钥与使用状态</h1>
            <p>账号权限由冰茶本地管理，密钥只在提交时经服务端转发。</p>
          </div>
          <div className="login-brand__status">
            <ShieldCheck size={20} weight="fill" />
            <span>HTTPS 安全连接</span>
          </div>
        </div>
      </section>

      <section className="login-panel">
        <form className="login-form" onSubmit={submit}>
          <div className="login-form__heading">
            <h2>登录冰茶</h2>
            <p>使用渠道系统账号继续。</p>
          </div>

          <label className="field">
            <span>账号</span>
            <div className="input-shell">
              <Key size={18} />
              <input
                autoComplete="username"
                name="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="请输入账号"
                required
              />
            </div>
          </label>

          <label className="field">
            <span>密码</span>
            <div className="input-shell">
              <ShieldCheck size={18} />
              <input
                autoComplete="current-password"
                name="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="请输入密码"
                required
              />
              <button
                className="input-action"
                type="button"
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
                title={showPassword ? "隐藏密码" : "显示密码"}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? <EyeSlash size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </label>

          {error ? (
            <div className="inline-message inline-message--danger" role="alert">
              <XCircle size={18} weight="fill" />
              <span>{error}</span>
            </div>
          ) : null}

          <button className="button button--primary login-submit" type="submit" disabled={loading}>
            {loading ? <span className="button-loader" aria-hidden="true" /> : <SignOut size={18} />}
            {loading ? "正在验证" : "登录控制台"}
          </button>
        </form>
      </section>
    </main>
  );
}

function LoadingScreen() {
  return (
    <div className="loading-shell" aria-label="正在加载">
      <div className="loading-bar" />
      <div className="loading-brand">
        <Brand />
      </div>
    </div>
  );
}

function EmptyAccess() {
  return (
    <section className="empty-state">
      <WarningCircle size={34} />
      <h2>当前账号没有可用渠道</h2>
      <p>渠道权限由上游账号配置决定，请联系管理员开通后重新登录。</p>
    </section>
  );
}

const channels = [
  {
    id: "openai",
    name: "OpenAI Key",
    description: "GPT 系列模型",
    icon: Crosshair,
  },
  {
    id: "azure",
    name: "Azure Key",
    description: "Azure OpenAI 服务",
    icon: Cloud,
  },
  {
    id: "anthropic",
    name: "Anthropic Key",
    description: "Claude 官方 API",
    icon: Robot,
    implemented: true,
  },
  {
    id: "bedrock",
    name: "AWS Bedrock",
    description: "跨区域推理",
    icon: Lightning,
  },
  {
    id: "bedrock-new",
    name: "AWS Bedrock（新版）",
    description: "Bedrock Mantle",
    icon: RocketLaunch,
  },
  {
    id: "aws-platform",
    name: "AWS Platform",
    description: "AWS 平台渠道",
    icon: GlobeHemisphereWest,
  },
];

function UploadHub({ enabledChannels }) {
  const [selectedChannel, setSelectedChannel] = useState(null);

  if (selectedChannel === "anthropic") {
    return (
      <div className="channel-detail">
        <button
          className="button button--secondary button--compact channel-back"
          type="button"
          onClick={() => setSelectedChannel(null)}
        >
          <ArrowLeft size={17} />
          返回选择
        </button>
        <UploadView />
      </div>
    );
  }

  return (
    <section className="channel-picker">
      <header className="channel-picker__heading">
        <CloudArrowUp size={22} />
        <h2>选择渠道类型</h2>
      </header>
      <div className="channel-grid">
        {channels.map((channel) => {
          const Icon = channel.icon;
          const enabled = channel.implemented && enabledChannels.includes(channel.id);
          return (
            <button
              className="channel-card"
              type="button"
              key={channel.id}
              disabled={!enabled}
              onClick={() => setSelectedChannel(channel.id)}
            >
              <Icon className="channel-card__icon" size={40} weight="duotone" />
              <strong>{channel.name}</strong>
              <span>{channel.description}</span>
              {!enabled ? <small>暂未开放</small> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function UploadView() {
  const [keys, setKeys] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const keyCount = countKeys(keys);

  async function submit(event) {
    event.preventDefault();
    if (!keyCount || running) return;
    setRunning(true);
    setProgress({ current: 0, total: keyCount, label: "正在提交" });
    setResult(null);
    setError("");

    try {
      const response = await fetch(endpoint("api/channel/anthropic/upload"), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key_list: keys }),
      });
      await consumeSse(response, (eventData) => {
        if (eventData.type === "progress") {
          setProgress({
            current: Number(eventData.current || 0),
            total: Number(eventData.total || keyCount),
            label: stageLabel(eventData.stage, eventData.wait_seconds),
            stage: eventData.stage,
          });
        }
        if (eventData.type === "done") {
          setResult(eventData);
          const retryKeys = Array.isArray(eventData.upload_failed_keys)
            ? eventData.upload_failed_keys
            : [];
          setKeys(retryKeys.map((item) => (typeof item === "string" ? item : item.key)).filter(Boolean).join("\n"));
          setProgress({
            current: Number(eventData.total || keyCount),
            total: Number(eventData.total || keyCount),
            label: "处理完成",
            stage: "done",
          });
        }
        if (eventData.type === "error") {
          setError(eventData.detail || "服务端处理失败");
        }
      });
    } catch (requestError) {
      setError(requestError.message || "网络连接失败");
    } finally {
      setRunning(false);
    }
  }

  const progressValue =
    progress && progress.total > 0 ? Math.min(100, (progress.current / progress.total) * 100) : 0;
  const failedItems = [
    ...(result?.probe_failed_keys || []).map((item) => ({ item, type: "检测失败" })),
    ...(result?.upload_failed_keys || []).map((item) => ({ item, type: "写入失败" })),
  ];

  return (
    <div className="workspace-grid">
      <section className="tool-panel">
        <header className="section-heading">
          <div>
            <h2>Anthropic 密钥入库</h2>
            <p>
              每行粘贴一个 <code>sk-ant-</code> 密钥，提交后会依次检测并创建渠道。
            </p>
          </div>
          <span className="channel-badge">Anthropic</span>
        </header>

        <form onSubmit={submit} className="key-form">
          <label className="field field--grow">
            <span>密钥列表</span>
            <textarea
              value={keys}
              onChange={(event) => setKeys(event.target.value)}
              placeholder={"sk-ant-api03-...\nsk-ant-api03-..."}
              spellCheck="false"
              autoComplete="off"
              disabled={running}
            />
          </label>

          <div className="form-meta">
            <span>{keyCount ? `已识别 ${keyCount} 个密钥` : "等待输入密钥"}</span>
            <span>页面不会保存输入内容</span>
          </div>

          {error ? (
            <div className="inline-message inline-message--danger" role="alert">
              <XCircle size={18} weight="fill" />
              <span>{error}</span>
            </div>
          ) : null}

          <button className="button button--primary" type="submit" disabled={!keyCount || running}>
            {running ? <span className="button-loader" aria-hidden="true" /> : <UploadSimple size={18} />}
            {running ? "正在处理" : "提交密钥"}
          </button>
        </form>
      </section>

      <aside className="run-panel" aria-live="polite">
        <header className="run-panel__header">
          <h3>本次处理</h3>
          <span className={`run-state${running ? " run-state--active" : ""}`}>
            {running ? "运行中" : result ? "已完成" : "等待提交"}
          </span>
        </header>

        {progress ? (
          <div className="progress-block">
            <div className="progress-copy">
              <strong>{progress.label}</strong>
              <span>
                {progress.current} / {progress.total}
              </span>
            </div>
            <progress className="progress-track" max="100" value={progressValue}>
              {Math.round(progressValue)}%
            </progress>
          </div>
        ) : (
          <div className="run-empty">
            <CloudArrowUp size={32} />
            <p>提交后，这里会实时显示排队、检测和写入进度。</p>
          </div>
        )}

        {result ? (
          <div className="result-summary">
            <div className="result-metrics">
              <div>
                <strong>{Number(result.success_total || 0)}</strong>
                <span>成功</span>
              </div>
              <div>
                <strong>{Number(result.duplicate_failed_total || result.already_uploaded_total || 0)}</strong>
                <span>重复</span>
              </div>
              <div>
                <strong>{Number(result.probe_failed_total || 0)}</strong>
                <span>检测失败</span>
              </div>
              <div>
                <strong>{Number(result.upload_failed_total || 0)}</strong>
                <span>写入失败</span>
              </div>
            </div>
            {failedItems.length ? (
              <div className="failed-list">
                <h4>需要检查的密钥</h4>
                {failedItems.slice(0, 20).map(({ item, type }, index) => {
                  const value = typeof item === "string" ? item : item.key;
                  return (
                    <div className="failed-row" key={`${value}-${index}`}>
                      <code>{maskKey(value)}</code>
                      <span>{type}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="inline-message inline-message--success">
                <CheckCircle size={18} weight="fill" />
                <span>本次处理没有需要重试的密钥。</span>
              </div>
            )}
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function StatusBadge({ tone = "neutral", children }) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}

function QueryView({ userType }) {
  const [date, setDate] = useState("");
  const [hour, setHour] = useState("");
  const [minute, setMinute] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [rows, setRows] = useState([]);
  const [statusRows, setStatusRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [totalUsd, setTotalUsd] = useState(0);
  const [statusOnly, setStatusOnly] = useState(
    userType === "status_only" || userType === "key_status",
  );
  const [usageFilter, setUsageFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [suffixFilter, setSuffixFilter] = useState("");
  const [sortDirection, setSortDirection] = useState("desc");
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [backupTimes, setBackupTimes] = useState({});
  const pageSize = 25;

  async function loadBackupTimes() {
    try {
      const response = await request("api/keys");
      const times = {};
      for (const item of response.data || []) {
        const recordedAt = item.first_seen_at;
        const fullKey = String(item.key || "");
        const suffix = keySuffix(fullKey);
        if (!recordedAt || !fullKey || !suffix) continue;
        times[`full:${fullKey}`] = recordedAt;
        const suffixKey = `suffix:${suffix}`;
        if (!(suffixKey in times)) {
          times[suffixKey] = recordedAt;
        } else if (times[suffixKey] !== recordedAt) {
          times[suffixKey] = null;
        }
      }
      setBackupTimes(times);
    } catch {
      setBackupTimes({});
    }
  }

  useEffect(() => {
    loadBackupTimes();
  }, []);

  async function submit(event) {
    event.preventDefault();
    setRunning(true);
    setError("");
    setProgress("正在连接查询服务");
    setRows([]);
    setStatusRows([]);
    setSummary(null);
    setTotalUsd(0);
    setPage(1);

    try {
      const response = await fetch(endpoint("api/channel/anthropic/usage"), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key_list: "", date, hour, minute }),
      });
      await consumeSse(response, (eventData) => {
        if (
          eventData.type === "status_item" ||
          eventData.type === "status_summary" ||
          (eventData.type === "done" && eventData.status_only)
        ) {
          setStatusOnly(true);
        }
        if (eventData.type === "status_item") {
          setStatusRows((current) => [...current, eventData]);
          setProgress(`${eventData.progress || 0} / ${eventData.total_keys || 0}`);
        }
        if (eventData.type === "status_summary") {
          setSummary(eventData);
          if (Array.isArray(eventData.records)) setStatusRows(eventData.records);
          setProgress("查询完成");
        }
        if (eventData.type === "item" || eventData.type === "usage_item") {
          setRows((current) => [...current, eventData]);
          setTotalUsd(Number(eventData.total_usd || 0));
          setProgress(`${eventData.progress || 0} / ${eventData.total_keys || 0}`);
        }
        if (eventData.type === "summary") {
          setSummary(eventData);
          setTotalUsd(Number(eventData.total_usd || 0));
        }
        if (eventData.type === "done") {
          setSummary((current) => ({ ...(current || {}), ...eventData }));
          setTotalUsd(Number(eventData.total_usd || 0));
          setProgress("查询完成");
        }
        if (eventData.type === "error") setError(eventData.detail || "查询失败");
      });
    } catch (requestError) {
      setError(requestError.message || "查询服务连接失败");
    } finally {
      setRunning(false);
      loadBackupTimes();
    }
  }

  const filteredStatusRows = useMemo(() => {
    const suffix = suffixFilter.trim().toLowerCase();
    return [...statusRows]
      .filter((item) => {
        if (usageFilter === "zero" && !(item.zero_usage === true || item.nonzero === false)) return false;
        if (usageFilter === "unknown" && item.usage_lte_20 != null) return false;
        if (usageFilter === "lte1" && item.usage_lte_1 !== true) return false;
        if (usageFilter === "lte5" && item.usage_lte_5 !== true) return false;
        if (usageFilter === "lte10" && item.usage_lte_10 !== true) return false;
        if (usageFilter === "lte15" && item.usage_lte_15 !== true) return false;
        if (usageFilter === "lte20" && item.usage_lte_20 !== true) return false;
        if (usageFilter === "gt20" && item.usage_lte_20 !== false) return false;
        if (stateFilter === "auto_disabled" && !item.auto_disabled) return false;
        if (
          stateFilter === "normal" &&
          (item.auto_disabled || (item.status_text && item.status_text !== "正常"))
        ) {
          return false;
        }
        if (suffix && !String(item.key || "").toLowerCase().endsWith(suffix)) return false;
        return true;
      })
      .sort((a, b) => {
        const aTime =
          Date.parse(localRecordedAt(backupTimes, a.key) || "") ||
          Number(a.uploaded_at_epoch || 0) ||
          Date.parse(a.uploaded_at || "") ||
          0;
        const bTime =
          Date.parse(localRecordedAt(backupTimes, b.key) || "") ||
          Number(b.uploaded_at_epoch || 0) ||
          Date.parse(b.uploaded_at || "") ||
          0;
        const difference = aTime - bTime;
        return (difference || String(a.key || "").localeCompare(String(b.key || ""))) *
          (sortDirection === "asc" ? 1 : -1);
      });
  }, [statusRows, usageFilter, stateFilter, suffixFilter, sortDirection, backupTimes]);

  useEffect(() => {
    setPage(1);
  }, [usageFilter, stateFilter, suffixFilter, sortDirection]);

  const pageCount = Math.max(1, Math.ceil(filteredStatusRows.length / pageSize));
  const visibleStatusRows = filteredStatusRows.slice((page - 1) * pageSize, page * pageSize);

  async function exportRows() {
    if (!filteredStatusRows.length || exporting) return;
    setExporting(true);
    setError("");
    try {
      const response = await fetch(endpoint("api/channel/anthropic/export"), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: filteredStatusRows }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || "导出失败");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const matched = disposition.match(/filename="?([^";]+)"?/i);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = matched?.[1] || "bingcha-key-status.xlsx";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setExporting(false);
    }
  }

  const hasResults = rows.length > 0 || statusRows.length > 0 || summary;
  const sortedUsageRows = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const aTime =
          Date.parse(localRecordedAt(backupTimes, a.key) || "") ||
          Number(a.uploaded_at_epoch || 0) ||
          Date.parse(a.uploaded_at || "") ||
          0;
        const bTime =
          Date.parse(localRecordedAt(backupTimes, b.key) || "") ||
          Number(b.uploaded_at_epoch || 0) ||
          Date.parse(b.uploaded_at || "") ||
          0;
        return bTime - aTime;
      }),
    [rows, backupTimes],
  );

  return (
    <div className="query-layout">
      <section className="query-form-panel">
        <header className="section-heading">
          <div>
            <h2>{statusOnly ? "查询 Key 状态" : "查询 Anthropic 用量"}</h2>
          </div>
          <span className="channel-badge">Anthropic</span>
        </header>

        <form onSubmit={submit} className="query-form">
          <div className="filter-row">
            <label className="field">
              <span>日期</span>
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </label>
            <label className="field">
              <span>小时</span>
              <select value={hour} onChange={(event) => setHour(event.target.value)}>
                <option value="">全天</option>
                {Array.from({ length: 24 }, (_, index) => {
                  const value = String(index).padStart(2, "0");
                  return (
                    <option value={value} key={value}>
                      {value}
                    </option>
                  );
                })}
              </select>
            </label>
            <label className="field">
              <span>分钟</span>
              <input
                inputMode="numeric"
                maxLength={2}
                value={minute}
                onChange={(event) => setMinute(event.target.value.replace(/\D/g, "").slice(0, 2))}
                placeholder="00-59"
              />
            </label>
          </div>

          {error ? (
            <div className="inline-message inline-message--danger" role="alert">
              <XCircle size={18} weight="fill" />
              <span>{error}</span>
            </div>
          ) : null}

          <button className="button button--primary" type="submit" disabled={running}>
            {running ? <span className="button-loader" aria-hidden="true" /> : <MagnifyingGlass size={18} />}
            {running ? "正在查询" : statusOnly ? "查询 Key 状态" : "查询用量"}
          </button>
        </form>
      </section>

      <section className="results-panel" aria-live="polite">
        <header className="results-header">
          <div>
            <h3>查询结果</h3>
            <p>{progress || "提交查询后显示实时结果"}</p>
          </div>
          {!statusOnly && hasResults ? (
            <div className="total-amount">
              <span>累计用量</span>
              <strong>${totalUsd.toFixed(4)}</strong>
            </div>
          ) : null}
        </header>

        {!hasResults && !running ? (
          <div className="results-empty">
            <ListMagnifyingGlass size={34} />
            <p>还没有查询结果。</p>
          </div>
        ) : null}

        {running && !hasResults ? <ResultsSkeleton /> : null}

        {statusOnly && summary ? <StatusSummary summary={summary} /> : null}

        {statusRows.length ? (
          <>
            <div className="table-toolbar">
              <select value={usageFilter} onChange={(event) => setUsageFilter(event.target.value)}>
                <option value="all">全部用量</option>
                <option value="zero">零用量</option>
                <option value="lte1">不足 1 美元</option>
                <option value="lte5">不足 5 美元</option>
                <option value="lte10">不足 10 美元</option>
                <option value="lte15">不足 15 美元</option>
                <option value="lte20">不足 20 美元</option>
                <option value="gt20">大于 20 美元</option>
                <option value="unknown">用量未知</option>
              </select>
              <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
                <option value="all">全部状态</option>
                <option value="normal">正常</option>
                <option value="auto_disabled">自动禁用</option>
              </select>
              <input
                value={suffixFilter}
                onChange={(event) => setSuffixFilter(event.target.value)}
                placeholder="按密钥后缀筛选"
              />
              <select value={sortDirection} onChange={(event) => setSortDirection(event.target.value)}>
                <option value="desc">时间倒序</option>
                <option value="asc">时间正序</option>
              </select>
              <button
                className="button button--secondary button--compact"
                type="button"
                onClick={exportRows}
                disabled={exporting || !filteredStatusRows.length}
              >
                <DownloadSimple size={17} />
                {exporting ? "正在导出" : "导出 XLSX"}
              </button>
            </div>
            <div className="table-note">
              当前显示 {filteredStatusRows.length} / {statusRows.length} 条
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>密钥</th>
                    <th>本地录入时间</th>
                    <th>状态</th>
                    <th>用量区间</th>
                    <th>用量状态</th>
                    <th>自动处理</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleStatusRows.map((item, index) => (
                    <tr key={`${item.key || "key"}-${index}`}>
                      <td>
                        <code>{maskKey(item.key)}</code>
                      </td>
                      <td>
                        {formatDate(
                          localRecordedAt(backupTimes, item.key),
                          "未知",
                        )}
                      </td>
                      <td>
                        <StatusBadge tone={statusTone(item.status_text || item.status)}>
                          {item.status_text || item.status || "未知"}
                        </StatusBadge>
                      </td>
                      <td>{usageRange(item)}</td>
                      <td>
                        {item.zero_usage === true || item.nonzero === false ? (
                          <StatusBadge tone="warning">零用量</StatusBadge>
                        ) : item.zero_usage === false || item.nonzero === true ? (
                          <StatusBadge tone="success">非零用量</StatusBadge>
                        ) : (
                          <StatusBadge>未知</StatusBadge>
                        )}
                      </td>
                      <td>
                        {item.auto_disabled ? (
                          <span className="reason-cell">
                            <StatusBadge tone="danger">已禁用</StatusBadge>
                            {item.disable_reason ? <small>{item.disable_reason}</small> : null}
                          </span>
                        ) : (
                          <StatusBadge tone="success">未禁用</StatusBadge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pageCount > 1 ? (
              <div className="pagination">
                <button
                  className="icon-button"
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  aria-label="上一页"
                  title="上一页"
                >
                  <CaretLeft size={18} />
                </button>
                <span>
                  第 {page} / {pageCount} 页
                </span>
                <button
                  className="icon-button"
                  type="button"
                  disabled={page >= pageCount}
                  onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
                  aria-label="下一页"
                  title="下一页"
                >
                  <CaretRight size={18} />
                </button>
              </div>
            ) : null}
          </>
        ) : null}

        {!statusOnly && sortedUsageRows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>密钥</th>
                  <th>本地录入时间</th>
                  <th>源站上传时间</th>
                  <th>累计用量</th>
                  <th>状态</th>
                  <th>自动禁用 / 原因</th>
                </tr>
              </thead>
              <tbody>
                {sortedUsageRows.map((item, index) => (
                  <tr key={`${item.key || "key"}-${index}`}>
                    <td>
                      <code>{maskKey(item.key)}</code>
                    </td>
                    <td>
                      {formatDate(
                        localRecordedAt(backupTimes, item.key),
                        "未知",
                      )}
                    </td>
                    <td>{item.uploaded_at || "未知"}</td>
                    <td className="numeric">${Number(item.key_usd || 0).toFixed(4)}</td>
                    <td>
                      <StatusBadge tone={statusTone(item.status_text)}>
                        {item.status_text || "未知"}
                      </StatusBadge>
                    </td>
                    <td>
                      {item.auto_disabled ? (
                        <span className="reason-cell">
                          <StatusBadge tone="danger">已自动禁用</StatusBadge>
                          {item.disable_reason ? <small>{item.disable_reason}</small> : null}
                        </span>
                      ) : (
                        <StatusBadge tone="success">未禁用</StatusBadge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function StatusSummary({ summary }) {
  const total = Number(summary.total_keys || summary.found_count || 0);
  const metrics = [
    ["查询到 Key", total],
    ["零用量", Number(summary.zero_usage_count || 0)],
    ["自动禁用", Number(summary.auto_disabled_count || 0)],
    ["不足 1 美元", Number(summary.usage_lte_1_count || 0)],
    ["不足 5 美元", Number(summary.usage_lte_5_count || 0)],
    ["不足 20 美元", Number(summary.usage_lte_20_count || 0)],
  ];
  return (
    <div className="status-summary">
      {metrics.map(([label, value]) => (
        <div key={label}>
          <strong>{value}</strong>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="results-skeleton" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function formatDate(value, emptyLabel = "尚未登录") {
  if (!value) return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function GeneratedCredentials({ credentials, onDismiss }) {
  const [copied, setCopied] = useState(false);

  async function copyCredentials() {
    await navigator.clipboard.writeText(
      `账号：${credentials.username}\n密码：${credentials.password}`,
    );
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <section className="credential-result" aria-live="polite">
      <div className="credential-result__heading">
        <div>
          <CheckCircle size={20} weight="fill" />
          <strong>{credentials.action === "reset" ? "新密码已生成" : "账号已生成"}</strong>
        </div>
        <button className="text-button" type="button" onClick={onDismiss}>
          已保存
        </button>
      </div>
      <dl>
        <div>
          <dt>账号</dt>
          <dd>{credentials.username}</dd>
        </div>
        <div>
          <dt>密码</dt>
          <dd>{credentials.password}</dd>
        </div>
      </dl>
      <button className="button button--secondary button--compact" type="button" onClick={copyCredentials}>
        <Copy size={17} />
        {copied ? "已复制" : "复制账号密码"}
      </button>
      <p>密码仅在这里显示一次，关闭后无法再次查看，只能重新生成。</p>
    </section>
  );
}

function AdminAccountDetail({ user, onClose }) {
  const [keyRecords, setKeyRecords] = useState([]);
  const [usageRows, setUsageRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadDetail() {
      setLoading(true);
      setError("");
      setProgress("正在读取本地 Key");
      setKeyRecords([]);
      setUsageRows([]);
      setSummary(null);

      try {
        const metadataResponse = await request(`api/admin/users/${user.id}/keys`);
        const records = metadataResponse.data?.keys || [];
        if (cancelled) return;
        setKeyRecords(records);
        if (!records.length) {
          setSummary({
            queried: 0,
            displayed: 0,
            total_usd: 0,
            failed_key_count: 0,
          });
          setProgress("该账号还没有录入 Key");
          return;
        }

        setProgress(`正在查询 ${records.length} 个 Key`);
        const response = await fetch(
          endpoint(`api/admin/users/${user.id}/anthropic/usage`),
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date: "", hour: "", minute: "" }),
          },
        );
        await consumeSse(response, (eventData) => {
          if (cancelled) return;
          if (eventData.type === "item" || eventData.type === "usage_item") {
            setUsageRows((current) => [...current, eventData]);
            setProgress(`${eventData.progress || 0} / ${eventData.total_keys || records.length}`);
          }
          if (eventData.type === "done" || eventData.type === "summary") {
            setSummary((current) => ({ ...(current || {}), ...eventData }));
            setProgress("查询完成");
          }
          if (eventData.type === "error") {
            setError(eventData.detail || "查询失败");
          }
        });
      } catch (requestError) {
        if (!cancelled) setError(requestError.message || "账号详情加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadDetail();
    return () => {
      cancelled = true;
    };
  }, [user.id, refreshToken]);

  const usageBySuffix = useMemo(() => indexKeyMetadata(usageRows), [usageRows]);
  const detailRows = useMemo(
    () =>
      keyRecords.map((record) => ({
        local: record,
        usage: metadataForKey(usageBySuffix, record.key),
      })),
    [keyRecords, usageBySuffix],
  );
  const totalUsd = Number(summary?.total_usd || 0);
  const disabledCount = detailRows.filter(({ usage }) => usage?.auto_disabled).length;
  const normalCount = detailRows.filter(
    ({ usage }) => usage && !usage.auto_disabled && usage.status_text === "正常",
  ).length;

  return (
    <section className="account-detail" aria-live="polite">
      <header className="accounts-panel__header account-detail__header">
        <div>
          <h2>{user.username}</h2>
          <p>{progress || "查看该账号录入的 Key 与源站状态"}</p>
        </div>
        <div className="row-actions">
          <button
            className="icon-button"
            type="button"
            onClick={() => setRefreshToken((value) => value + 1)}
            disabled={loading}
            aria-label={`刷新 ${user.username} 的详情`}
            title="刷新账号详情"
          >
            <ListMagnifyingGlass size={18} />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label={`关闭 ${user.username} 的详情`}
            title="关闭账号详情"
          >
            <XCircle size={18} />
          </button>
        </div>
      </header>

      {error ? (
        <div className="inline-message inline-message--danger account-detail__message" role="alert">
          <XCircle size={18} weight="fill" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="account-detail__metrics">
        <div>
          <strong>{keyRecords.length}</strong>
          <span>本地 Key</span>
        </div>
        <div>
          <strong>${totalUsd.toFixed(4)}</strong>
          <span>累计总用量</span>
        </div>
        <div>
          <strong>{normalCount}</strong>
          <span>状态正常</span>
        </div>
        <div>
          <strong>{disabledCount}</strong>
          <span>自动禁用</span>
        </div>
      </div>

      {loading && !detailRows.length ? (
        <ResultsSkeleton />
      ) : detailRows.length ? (
        <div className="table-scroll account-detail__table">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>本地录入时间</th>
                <th>源站上传时间</th>
                <th>累计用量</th>
                <th>状态</th>
                <th>自动禁用 / 原因</th>
              </tr>
            </thead>
            <tbody>
              {detailRows.map(({ local, usage }) => (
                <tr key={local.id}>
                  <td><code>{local.key}</code></td>
                  <td>{formatDate(local.first_seen_at, "未知")}</td>
                  <td>{usage?.uploaded_at || local.upstream_uploaded_at || "未知"}</td>
                  <td className="numeric">
                    {usage ? `$${Number(usage.key_usd || 0).toFixed(4)}` : "查询不到"}
                  </td>
                  <td>
                    <StatusBadge tone={usage ? statusTone(usage.status_text) : "neutral"}>
                      {usage?.status_text || "未查询到"}
                    </StatusBadge>
                  </td>
                  <td>
                    {usage?.auto_disabled ? (
                      <span className="reason-cell">
                        <StatusBadge tone="danger">已自动禁用</StatusBadge>
                        {usage.disable_reason ? <small>{usage.disable_reason}</small> : null}
                      </span>
                    ) : usage ? (
                      <StatusBadge tone="success">未禁用</StatusBadge>
                    ) : (
                      <StatusBadge>未知</StatusBadge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="accounts-empty account-detail__empty">
          <Key size={30} />
          <p>该账号还没有录入 Anthropic Key。</p>
        </div>
      )}
    </section>
  );
}

function AdminView({ currentUsername }) {
  const [users, setUsers] = useState([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [busyUserId, setBusyUserId] = useState(null);
  const [error, setError] = useState("");
  const [credentials, setCredentials] = useState(null);
  const [selectedUser, setSelectedUser] = useState(null);

  async function loadUsers() {
    setLoading(true);
    setError("");
    try {
      const response = await request("api/admin/users");
      setUsers(response.data || []);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  async function createAccount(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setCredentials(null);
    try {
      const response = await request("api/admin/users", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      setUsers((current) => [...current.filter((item) => item.id !== response.data.user.id), response.data.user]);
      setCredentials({
        action: "create",
        username: response.data.user.username,
        password: response.data.password,
      });
      setUsername("");
      setPassword("");
      await loadUsers();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleStatus(user) {
    setBusyUserId(user.id);
    setError("");
    try {
      const status = user.status === "active" ? "disabled" : "active";
      const response = await request(`api/admin/users/${user.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setUsers((current) =>
        current.map((item) => (item.id === user.id ? response.data : item)),
      );
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyUserId(null);
    }
  }

  async function resetPassword(user) {
    setBusyUserId(user.id);
    setError("");
    setCredentials(null);
    try {
      const response = await request(`api/admin/users/${user.id}/password`, {
        method: "POST",
        body: "{}",
      });
      setCredentials({
        action: "reset",
        username: response.data.user.username,
        password: response.data.password,
      });
      setUsers((current) =>
        current.map((item) => (item.id === user.id ? response.data.user : item)),
      );
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyUserId(null);
    }
  }

  const activeCount = users.filter((user) => user.status === "active").length;

  return (
    <div className="admin-layout">
      <section className="account-generator">
        <header className="section-heading">
          <div>
            <h2>生成冰茶账号</h2>
            <p>留空时自动生成账号和高强度密码，每个账号使用独立的数据空间。</p>
          </div>
          <span className="channel-badge">管理员</span>
        </header>

        <form className="account-form" onSubmit={createAccount}>
          <label className="field">
            <span>账号（可选）</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value.toLowerCase())}
              placeholder="自动生成"
              autoComplete="off"
              pattern="[a-z0-9][a-z0-9_-]{3,31}"
            />
          </label>
          <label className="field">
            <span>密码（可选）</span>
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="自动生成"
              autoComplete="new-password"
              minLength={10}
              maxLength={128}
            />
          </label>

          {error ? (
            <div className="inline-message inline-message--danger" role="alert">
              <XCircle size={18} weight="fill" />
              <span>{error}</span>
            </div>
          ) : null}

          <button className="button button--primary" type="submit" disabled={submitting}>
            {submitting ? <span className="button-loader" aria-hidden="true" /> : <UserPlus size={18} />}
            {submitting ? "正在生成" : "生成账号"}
          </button>
        </form>

        {credentials ? (
          <GeneratedCredentials
            credentials={credentials}
            onDismiss={() => setCredentials(null)}
          />
        ) : null}
      </section>

      <section className="accounts-panel">
        <header className="accounts-panel__header">
          <div>
            <h2>账号管理</h2>
            <p>{users.length} 个账号，{activeCount} 个正在使用</p>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={loadUsers}
            disabled={loading}
            aria-label="刷新账号列表"
            title="刷新账号列表"
          >
            <UsersThree size={18} />
          </button>
        </header>

        {loading ? (
          <ResultsSkeleton />
        ) : users.length ? (
          <div className="table-scroll">
            <table className="accounts-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>状态</th>
                  <th>Key 数</th>
                  <th>创建时间</th>
                  <th>最后登录</th>
                  <th aria-label="账号操作" />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const isCurrent = user.username === currentUsername;
                  const busy = busyUserId === user.id;
                  return (
                    <tr key={user.id}>
                      <td>
                        <div className="account-name">
                          <strong>{user.username}</strong>
                          <span>{user.role === "admin" ? "管理员" : "普通账号"}{isCurrent ? " · 当前账号" : ""}</span>
                        </div>
                      </td>
                      <td>
                        <StatusBadge tone={user.status === "active" ? "success" : "danger"}>
                          {user.status === "active" ? "正常" : "已停用"}
                        </StatusBadge>
                      </td>
                      <td className="numeric">{Number(user.key_count || 0)}</td>
                      <td>{formatDate(user.created_at)}</td>
                      <td>{formatDate(user.last_login_at)}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            className={`icon-button${selectedUser?.id === user.id ? " is-active" : ""}`}
                            type="button"
                            onClick={() => setSelectedUser(user)}
                            disabled={busy}
                            aria-label={`查看 ${user.username} 的 Key 详情`}
                            title="查看 Key 与用量"
                          >
                            <Eye size={17} />
                          </button>
                          <button
                            className="icon-button"
                            type="button"
                            onClick={() => resetPassword(user)}
                            disabled={busy}
                            aria-label={`重置 ${user.username} 的密码`}
                            title="生成新密码"
                          >
                            <LockKey size={17} />
                          </button>
                          <button
                            className={`icon-button${user.status === "disabled" ? " icon-button--success" : " icon-button--danger"}`}
                            type="button"
                            onClick={() => toggleStatus(user)}
                            disabled={busy || isCurrent}
                            aria-label={`${user.status === "active" ? "停用" : "启用"} ${user.username}`}
                            title={isCurrent ? "不能停用当前账号" : user.status === "active" ? "停用账号" : "启用账号"}
                          >
                            <Power size={17} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="accounts-empty">
            <UsersThree size={30} />
            <p>还没有生成普通账号。</p>
          </div>
        )}
      </section>
      {selectedUser ? (
        <AdminAccountDetail
          key={selectedUser.id}
          user={selectedUser}
          onClose={() => setSelectedUser(null)}
        />
      ) : null}
    </div>
  );
}

function Console({ session, onLogout, theme, onThemeChange }) {
  const [view, setView] = useState("upload");
  const hasAnthropic = session.channels.includes("anthropic");

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__inner">
          <Brand compact />
          <div className="topbar__actions">
            <TrafficGapStatus />
            <div className="user-chip">
              <span className="user-chip__status" />
              <span>用户：{session.username}</span>
            </div>
            <button
              className="icon-button"
              type="button"
              onClick={onLogout}
              aria-label="退出登录"
              title="退出登录"
            >
              <SignOut size={18} />
            </button>
          </div>
        </div>
      </header>

      <main className="console-main">
        {hasAnthropic ? (
          <>
            <nav
              className={`view-tabs${session.role === "admin" ? " view-tabs--admin" : ""}`}
              aria-label="控制台功能"
            >
              <button
                className={view === "upload" ? "is-active" : ""}
                type="button"
                onClick={() => setView("upload")}
              >
                <UploadSimple size={18} />
                上号
              </button>
              <button
                className={view === "query" ? "is-active" : ""}
                type="button"
                onClick={() => setView("query")}
              >
                <Coins size={18} />
                查用量
              </button>
              {session.role === "admin" ? (
                <button
                  className={view === "accounts" ? "is-active" : ""}
                  type="button"
                  onClick={() => setView("accounts")}
                >
                  <UsersThree size={18} />
                  账号管理
                </button>
              ) : null}
            </nav>
            {view === "upload" ? <UploadHub enabledChannels={session.channels} /> : null}
            {view === "query" ? <QueryView userType={session.userType} /> : null}
            {view === "accounts" && session.role === "admin" ? (
              <AdminView currentUsername={session.username} />
            ) : null}
          </>
        ) : (
          <EmptyAccess />
        )}
      </main>
    </div>
  );
}

function App() {
  const [phase, setPhase] = useState("loading");
  const [session, setSession] = useState(null);
  const [theme, setTheme] = useState(() => {
    const saved = window.localStorage.getItem("bingcha-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("bingcha-theme", theme);
  }, [theme]);

  useEffect(() => {
    request("api/auth/me")
      .then((response) => {
        setSession(response.data);
        setPhase("console");
      })
      .catch(() => setPhase("login"));
  }, []);

  async function logout() {
    try {
      await request("api/auth/logout", { method: "POST", body: "{}" });
    } finally {
      setSession(null);
      setPhase("login");
    }
  }

  if (phase === "loading") return <LoadingScreen />;
  if (phase === "login") {
    return (
      <LoginScreen
        theme={theme}
        onThemeChange={setTheme}
        onLogin={(nextSession) => {
          setSession(nextSession);
          setPhase("console");
        }}
      />
    );
  }
  return (
    <Console
      session={session}
      onLogout={logout}
      theme={theme}
      onThemeChange={setTheme}
    />
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
