import { useState } from "react";
import { useAppStore } from "../stores/useAppStore";
import { Server, Save, Info } from "lucide-react";

export function Settings() {
  const { gfaApiUrl, updateGfaApiUrl } = useAppStore();
  const [url, setUrl] = useState(gfaApiUrl);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    updateGfaApiUrl(url);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">设置</h1>
        <p className="page-subtitle">API 配置与系统信息</p>
      </div>
      <div className="page-body">
        <div className="bento-grid bento-grid-2">
          {/* API Configuration */}
          <div className="card">
            <div className="card-header">
              <div className="flex items-center gap-2"><Server size={14} className="card-header-icon" /> API 服务器</div>
            </div>
            <div className="form-group">
              <label>API Base URL</label>
              <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://bcai.site" />
            </div>
            <div className="flex items-center gap-2">
              <button className="btn btn-primary btn-sm" onClick={handleSave}>
                <Save size={12} /> {saved ? "已保存 ✓" : "保存"}
              </button>
            </div>
          </div>

          {/* About */}
          <div className="card">
            <div className="card-header">
              <div className="flex items-center gap-2"><Info size={14} className="card-header-icon" /> 关于</div>
            </div>
            <div className="bento-grid bento-grid-2" style={{ gap: 10 }}>
              <div className="stat-card" style={{ padding: 14 }}>
                <span className="stat-label">应用</span>
                <span className="stat-value" style={{ fontSize: 16 }}>GFA Client</span>
              </div>
              <div className="stat-card" style={{ padding: 14 }}>
                <span className="stat-label">版本</span>
                <span className="stat-value" style={{ fontSize: 16 }}>v2.0.6</span>
              </div>
              <div className="stat-card" style={{ padding: 14 }}>
                <span className="stat-label">框架</span>
                <span className="stat-value" style={{ fontSize: 16 }}>Tauri v2</span>
              </div>
              <div className="stat-card" style={{ padding: 14 }}>
                <span className="stat-label">前端</span>
                <span className="stat-value" style={{ fontSize: 16 }}>React 19</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
