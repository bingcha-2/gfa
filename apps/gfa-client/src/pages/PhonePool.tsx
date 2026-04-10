import { useState, useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import { Phone, Upload, Trash2, ToggleLeft, ToggleRight } from "lucide-react";

export function PhonePool() {
  const { phones, loadPhones, importPhones, deletePhone, updatePhoneStatus } =
    useAppStore();
  const [importText, setImportText] = useState("");
  const [showImport, setShowImport] = useState(false);

  useEffect(() => {
    loadPhones();
  }, []);

  const handleImport = async () => {
    if (!importText.trim()) return;
    try {
      await importPhones(importText.trim());
      setImportText("");
      setShowImport(false);
    } catch (e) {
      console.error("Import failed:", e);
    }
  };

  const availableCount = phones.filter((p) => p.status === "available").length;
  const disabledCount = phones.filter((p) => p.status === "disabled").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, flex: 1, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>
            <Phone size={20} style={{ marginRight: 8, verticalAlign: "middle" }} />
            手机号池
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
            管理本地手机号，用于自动过 Google 手机号认证
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="badge badge-success">{availableCount} 可用</span>
          {disabledCount > 0 && (
            <span className="badge badge-danger">{disabledCount} 不可用</span>
          )}
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowImport(!showImport)}
          >
            <Upload size={14} />
            批量导入
          </button>
        </div>
      </div>

      {/* Import section */}
      {showImport && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ marginBottom: 8, fontSize: 13, color: "var(--text-secondary)" }}>
            每行一个，格式：<code>手机号|SMS验证码URL</code>
            <br />
            示例：<code>12345678901|https://sms222.us/?token=abc123</code>
          </div>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder={`12345678901|https://sms222.us/?token=xxx\n12345678902|https://sms222.us/?token=yyy`}
            style={{
              width: "100%",
              minHeight: 100,
              padding: 12,
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--bg-secondary)",
              color: "var(--text-primary)",
              fontFamily: "monospace",
              fontSize: 13,
              resize: "vertical",
            }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end" }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowImport(false)}>
              取消
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleImport}
              disabled={!importText.trim()}
            >
              导入
            </button>
          </div>
        </div>
      )}

      {/* Phone list */}
      <div className="card" style={{ flex: 1, overflow: "auto" }}>
        {phones.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: 48,
              color: "var(--text-secondary)",
            }}
          >
            <Phone size={48} strokeWidth={1} />
            <p style={{ marginTop: 12 }}>暂无手机号</p>
            <p style={{ fontSize: 13, opacity: 0.7 }}>
              点击「批量导入」添加手机号
            </p>
          </div>
        ) : (
          <table className="data-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>手机号</th>
                <th>国家码</th>
                <th>SMS URL</th>
                <th>使用次数</th>
                <th>状态</th>
                <th style={{ width: 100 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {phones.map((phone) => (
                <tr key={phone.id}>
                  <td>
                    <code style={{ fontSize: 13 }}>{phone.phone_number}</code>
                  </td>
                  <td>
                    <span style={{ fontSize: 13 }}>{phone.country_code}</span>
                  </td>
                  <td>
                    <span
                      style={{
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        maxWidth: 200,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        display: "inline-block",
                      }}
                      title={phone.sms_url}
                    >
                      {phone.sms_url}
                    </span>
                  </td>
                  <td>
                    <span style={{ fontSize: 13 }}>{phone.used_count}</span>
                  </td>
                  <td>
                    <span
                      className={`badge ${phone.status === "available" ? "badge-success" : "badge-danger"}`}
                    >
                      {phone.status === "available" ? "可用" : "不可用"}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        className="btn btn-ghost btn-xs"
                        title={phone.status === "available" ? "标记不可用" : "标记可用"}
                        onClick={() =>
                          updatePhoneStatus(
                            phone.id,
                            phone.status === "available" ? "disabled" : "available"
                          )
                        }
                      >
                        {phone.status === "available" ? (
                          <ToggleRight size={14} />
                        ) : (
                          <ToggleLeft size={14} />
                        )}
                      </button>
                      <button
                        className="btn btn-ghost btn-xs"
                        title="删除"
                        onClick={() => {
                          if (confirm("确定删除此手机号？")) {
                            deletePhone(phone.id);
                          }
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
