import { useState, useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import { Settings as SettingsIcon, Save } from "lucide-react";

export function Settings() {
  const { gfaApiUrl, updateGfaApiUrl } = useAppStore();
  const [url, setUrl] = useState(gfaApiUrl);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setUrl(gfaApiUrl);
  }, [gfaApiUrl]);

  const handleSaveUrl = async () => {
    await updateGfaApiUrl(url);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };


  return (
    <>
      <div className="page-header">
        <h1 className="page-title">设置</h1>
        <p className="page-subtitle">配置 GFA 后端地址和应用选项</p>
      </div>
      <div className="page-body animate-in">
        <div className="card mb-4">
          <div className="card-header">
            <span>GFA API 服务器</span>
            <SettingsIcon size={16} style={{ color: "var(--color-accent)" }} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label className="text-sm text-muted" style={{ display: "block", marginBottom: 6 }}>
              后端 API 地址（兑换码、订单查询、账号置换依赖此服务）
            </label>
            <div className="flex items-center gap-3">
              <input
                className="input"
                style={{ maxWidth: 400 }}
                placeholder="http://localhost:3000"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSaveUrl()}
              />
              <button className="btn btn-primary" onClick={handleSaveUrl}>
                <Save size={14} />
                {saved ? "已保存 ✓" : "保存"}
              </button>
            </div>
          </div>
        </div>


        <div className="card mb-4">
          <div className="card-header">关于</div>
          <div className="table-container">
            <table>
              <tbody>
                <tr>
                  <td style={{ color: "var(--color-text-muted)", width: 150 }}>应用名称</td>
                  <td>GFA Client</td>
                </tr>
                <tr>
                  <td style={{ color: "var(--color-text-muted)" }}>版本</td>
                  <td>0.1.0</td>
                </tr>
                <tr>
                  <td style={{ color: "var(--color-text-muted)" }}>技术栈</td>
                  <td>Tauri v2 + React + GFA API</td>
                </tr>
                <tr>
                  <td style={{ color: "var(--color-text-muted)" }}>浏览器自动化</td>
                  <td>服务端 Worker（通过 API 调度）</td>
                </tr>
                <tr>
                  <td style={{ color: "var(--color-text-muted)" }}>凭据格式</td>
                  <td style={{ fontFamily: "monospace", fontSize: 12 }}>email---password---recoveryEmail---totpSecret</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-header">数据说明</div>
          <div className="text-sm text-muted" style={{ lineHeight: 1.8 }}>
            <p>• 所有账号凭据存储在本地 SQLite 数据库中</p>
            <p>• 自动化操作（OAuth、登录测试、接受邀请）通过 GFA API 在服务端执行</p>
            <p>• Antigravity OAuth Token 存储在本地，仅用于 API 代理认证</p>
            <p>• 凭据在自动化请求时传输到服务端，任务完成后不会留存</p>
          </div>
        </div>
      </div>
    </>
  );
}
