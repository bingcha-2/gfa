"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { apiRequest, getErrorMessage } from "../lib/client-api";
import { Spinner } from "./spinner";

type FaqItem = {
  id: string;
  category: string;
  question: string;
  answer: string;
  sortOrder: number;
  published: boolean;
};

type EditorMode = "list" | "create" | "edit";

export function FaqPanel({ showToast }: { showToast: (type: "success" | "error" | "info", msg: string) => void }) {
  const [faqs, setFaqs] = useState<FaqItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<EditorMode>("list");
  const [editingFaq, setEditingFaq] = useState<FaqItem | null>(null);

  // Stabilize showToast ref to avoid re-triggering loadFaqs on every parent re-render
  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; });

  // Form state
  const [category, setCategory] = useState("");
  const [question, setQuestion] = useState("");
  const [sortOrder, setSortOrder] = useState(0);
  const [published, setPublished] = useState(true);
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  const loadFaqs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest<FaqItem[]>("faq/all");
      setFaqs(data);
    } catch (err) {
      showToastRef.current("error", getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // --- Contact settings ---
  const [settingsWechat, setSettingsWechat] = useState("");
  const [settingsQrUrl, setSettingsQrUrl] = useState("");
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsEditing, setSettingsEditing] = useState(false);
  const qrFileRef = useRef<HTMLInputElement>(null);

  const loadSettings = useCallback(async () => {
    try {
      const data = await apiRequest<Record<string, string>>("faq/settings");
      setSettingsWechat(data.contact_wechat ?? "");
      setSettingsQrUrl(data.contact_qrcode_url ?? "");
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadFaqs(); loadSettings(); }, [loadFaqs, loadSettings]);

  function resetForm() {
    setCategory("");
    setQuestion("");
    setSortOrder(0);
    setPublished(true);
    setEditingFaq(null);
    if (editorRef.current) editorRef.current.innerHTML = "";
  }

  function startCreate() {
    resetForm();
    setMode("create");
    setTimeout(() => { if (editorRef.current) editorRef.current.innerHTML = ""; }, 50);
  }

  function startEdit(faq: FaqItem) {
    setEditingFaq(faq);
    setCategory(faq.category);
    setQuestion(faq.question);
    setSortOrder(faq.sortOrder);
    setPublished(faq.published);
    setMode("edit");
    setTimeout(() => {
      if (editorRef.current) editorRef.current.innerHTML = faq.answer;
    }, 50);
  }

  async function handleSave() {
    const answer = editorRef.current?.innerHTML ?? "";
    if (!category.trim() || !question.trim() || !answer.trim()) {
      showToast("error", "分类、问题和答案不能为空");
      return;
    }
    setSaving(true);
    try {
      if (mode === "create") {
        await apiRequest("faq", {
          method: "POST",
          body: { category: category.trim(), question: question.trim(), answer, sortOrder, published },
        });
        showToast("success", "FAQ 已创建");
      } else if (mode === "edit" && editingFaq) {
        await apiRequest(`faq/${editingFaq.id}`, {
          method: "PATCH",
          body: { category: category.trim(), question: question.trim(), answer, sortOrder, published },
        });
        showToast("success", "FAQ 已更新");
      }
      resetForm();
      setMode("list");
      await loadFaqs();
    } catch (err) {
      showToast("error", getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("确定删除此 FAQ？")) return;
    try {
      await apiRequest(`faq/${id}`, { method: "DELETE" });
      showToast("success", "FAQ 已删除");
      await loadFaqs();
    } catch (err) {
      showToast("error", getErrorMessage(err));
    }
  }

  async function handleTogglePublish(faq: FaqItem) {
    try {
      await apiRequest(`faq/${faq.id}`, {
        method: "PATCH",
        body: { published: !faq.published },
      });
      showToast("success", faq.published ? "已取消发布" : "已发布");
      await loadFaqs();
    } catch (err) {
      showToast("error", getErrorMessage(err));
    }
  }

  // Rich text toolbar commands
  function execCmd(cmd: string, value?: string) {
    document.execCommand(cmd, false, value);
    editorRef.current?.focus();
  }

  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Upload image to server and insert URL into editor */
  async function insertImageFile(file: File) {
    if (!file.type.startsWith("image/")) return;
    // Limit to 10MB
    if (file.size > 10 * 1024 * 1024) {
      showToast("error", "图片不能超过 10MB");
      return;
    }

    // Save selection range BEFORE async operation (it will be lost)
    const editor = editorRef.current;
    if (!editor) return;

    let savedRange: Range | null = null;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }

    // Read as data URL for upload
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    showToast("info", "正在上传图片...");

    try {
      // Upload to server
      const result = await apiRequest<{ url: string }>("faq/upload-image", {
        method: "POST",
        body: { data: dataUrl },
      });

      // Create image element
      const img = document.createElement("img");
      img.src = result.url;
      img.style.maxWidth = "100%";
      img.style.borderRadius = "6px";
      img.style.margin = "8px 0";
      img.style.display = "block";

      // Try to restore saved selection, otherwise append to end
      if (savedRange && editor.contains(savedRange.startContainer)) {
        const restoredSel = window.getSelection();
        if (restoredSel) {
          restoredSel.removeAllRanges();
          restoredSel.addRange(savedRange);
          savedRange.deleteContents();
          savedRange.insertNode(img);
          // Move cursor after image
          savedRange.setStartAfter(img);
          savedRange.collapse(true);
          restoredSel.removeAllRanges();
          restoredSel.addRange(savedRange);
        }
      } else {
        // Fallback: append to end of editor
        editor.appendChild(img);
        // Add a line break after so user can type below the image
        const br = document.createElement("br");
        editor.appendChild(br);
      }

      editor.focus();
      showToast("success", "图片上传成功");
    } catch (err) {
      showToast("error", `图片上传失败: ${getErrorMessage(err)}`);
    }
  }

  function insertImage() {
    fileInputRef.current?.click();
  }

  function handleImageFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files) {
      for (let i = 0; i < files.length; i++) {
        insertImageFile(files[i]);
      }
    }
    // Reset so the same file can be selected again
    e.target.value = "";
  }

  function insertImageUrl() {
    const url = prompt("输入图片 URL:");
    if (url) execCmd("insertImage", url);
  }

  /** Handle paste: intercept images from clipboard */
  function handleEditorPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) insertImageFile(file);
        return;
      }
    }
  }

  /** Handle drag-and-drop images */
  function handleEditorDrop(e: React.DragEvent<HTMLDivElement>) {
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      if (files[i].type.startsWith("image/")) {
        e.preventDefault();
        insertImageFile(files[i]);
        return;
      }
    }
  }

  function insertLink() {
    const url = prompt("输入链接 URL:");
    if (url) execCmd("createLink", url);
  }

  // ─── Categories deduplication ───
  const categories = [...new Set(faqs.map(f => f.category))];

  if (loading) {
    return (
      <div className="panel-stack" style={{ padding: 40, alignItems: "center" }}>
        <Spinner size={24} color="var(--accent)" />
        <span className="muted">加载中...</span>
      </div>
    );
  }

  // ─── Editor view ───
  if (mode === "create" || mode === "edit") {
    return (
      <div className="panel-stack">
        <div className="workspace-head">
          <div className="section-copy">
            <p className="label">FAQ 管理</p>
            <h2 className="panel-title">{mode === "create" ? "新建 FAQ" : "编辑 FAQ"}</h2>
          </div>
          <button className="button secondary" onClick={() => { resetForm(); setMode("list"); }} type="button">
            ← 返回列表
          </button>
        </div>

        <div className="faq-admin-editor">
          <label>
            分类
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="例如: 加入家庭组常见问题"
                list="faq-categories"
              />
              <datalist id="faq-categories">
                {categories.map(c => <option key={c} value={c} />)}
              </datalist>
            </div>
          </label>
          <label>
            问题
            <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="例如: 提示地区/国家不一致怎么办？" />
          </label>
          <div style={{ display: "flex", gap: 12 }}>
            <label style={{ flex: 1 }}>
              排序权重
              <input type="number" value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value))} />
            </label>
            <label style={{ flex: 1 }}>
              发布状态
              <select value={published ? "true" : "false"} onChange={(e) => setPublished(e.target.value === "true")}>
                <option value="true">✅ 已发布</option>
                <option value="false">⏸ 未发布</option>
              </select>
            </label>
          </div>
          <label>答案（富文本）</label>
          {/* Hidden file input for image upload */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={handleImageFileChange}
          />
          {/* Rich text toolbar */}
          <div className="faq-admin-toolbar">
            <button type="button" onClick={() => execCmd("bold")} title="粗体"><b>B</b></button>
            <button type="button" onClick={() => execCmd("italic")} title="斜体"><i>I</i></button>
            <button type="button" onClick={() => execCmd("underline")} title="下划线"><u>U</u></button>
            <button type="button" onClick={() => execCmd("strikeThrough")} title="删除线"><s>S</s></button>
            <span style={{ width: 1, background: "var(--line)", margin: "4px 2px" }} />
            <button type="button" onClick={() => execCmd("formatBlock", "h3")} title="标题">H</button>
            <button type="button" onClick={() => execCmd("insertUnorderedList")} title="无序列表">• 列表</button>
            <button type="button" onClick={() => execCmd("insertOrderedList")} title="有序列表">1. 列表</button>
            <span style={{ width: 1, background: "var(--line)", margin: "4px 2px" }} />
            <button type="button" onClick={insertLink} title="插入链接">🔗 链接</button>
            <button type="button" onClick={insertImage} title="上传图片">📤 上传图片</button>
            <button type="button" onClick={insertImageUrl} title="图片URL">🔗 图片URL</button>
            <span style={{ width: 1, background: "var(--line)", margin: "4px 2px" }} />
            <button type="button" onClick={() => execCmd("removeFormat")} title="清除格式">✕ 格式</button>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "2px 0 6px" }}>
            💡 支持直接粘贴截图或拖放图片文件到编辑区
          </p>
          {/* Editable area */}
          <div
            ref={editorRef}
            className="faq-rich-area"
            contentEditable
            suppressContentEditableWarning
            data-placeholder="在此输入答案内容…可直接粘贴截图或拖放图片"
            onPaste={handleEditorPaste}
            onDrop={handleEditorDrop}
            onDragOver={(e) => e.preventDefault()}
          />
          <div className="field-actions">
            <button className="button" onClick={handleSave} disabled={saving} type="button">
              {saving ? <><Spinner size={14} color="white" /> 保存中...</> : "💾 保存"}
            </button>
            <button className="button secondary" onClick={() => { resetForm(); setMode("list"); }} type="button">
              取消
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── List view ───
  return (
    <div className="panel-stack">
      <div className="workspace-head">
        <div className="section-copy">
          <p className="label">FAQ 管理</p>
          <h2 className="panel-title">常见问题管理</h2>
          <p className="muted">管理 bcai.site/faq 公开页面上展示的常见问题。共 {faqs.length} 条。</p>
        </div>
        <div className="toolbar">
          <button className="button" onClick={startCreate} type="button">➕ 新建 FAQ</button>
          <button className="button secondary" onClick={loadFaqs} type="button">🔄 刷新</button>
        </div>
      </div>

      {/* === Contact settings section === */}
      <div style={{
        padding: '16px 20px',
        borderRadius: '14px',
        border: '1px solid var(--line)',
        background: 'linear-gradient(135deg, rgba(234,88,12,0.03), rgba(15,118,110,0.02))',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: settingsEditing ? '14px' : 0 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: '2px' }}>📱 售后客服设置</div>
            <div className="muted" style={{ fontSize: '0.8rem' }}>
              {!settingsEditing && (
                settingsWechat
                  ? <>微信号: <strong>{settingsWechat}</strong>{settingsQrUrl ? ' · 已设置二维码' : ' · 未设置二维码'}</>
                  : '未设置客服信息'
              )}
            </div>
          </div>
          <button
            className="button secondary small"
            onClick={() => setSettingsEditing(!settingsEditing)}
            type="button"
          >
            {settingsEditing ? '取消' : '⚙️ 编辑'}
          </button>
        </div>
        {settingsEditing && (
          <div style={{ display: 'grid', gap: '12px' }}>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'end', flexWrap: 'wrap' }}>
              <label style={{ flex: 1, minWidth: 200, display: 'grid', gap: '4px', fontSize: '12px', fontWeight: 700, color: 'var(--foreground-muted)' }}>
                客服微信号
                <input
                  value={settingsWechat}
                  onChange={(e) => setSettingsWechat(e.target.value)}
                  placeholder="例如: BingCha_Service"
                  style={{ padding: '8px 12px', border: '1px solid var(--line-strong)', borderRadius: '10px', fontSize: '14px' }}
                />
              </label>
            </div>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'end', flexWrap: 'wrap' }}>
              <label style={{ flex: 1, minWidth: 200, display: 'grid', gap: '4px', fontSize: '12px', fontWeight: 700, color: 'var(--foreground-muted)' }}>
                二维码图片 URL
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    value={settingsQrUrl}
                    onChange={(e) => setSettingsQrUrl(e.target.value)}
                    placeholder="/api/faq-images/xxx.png 或外部 URL"
                    style={{ flex: 1, padding: '8px 12px', border: '1px solid var(--line-strong)', borderRadius: '10px', fontSize: '14px' }}
                  />
                  <input
                    ref={qrFileRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (file.size > 10 * 1024 * 1024) { showToast('error', '图片不能超过 10MB'); return; }
                      const dataUrl = await new Promise<string>((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result as string);
                        reader.onerror = reject;
                        reader.readAsDataURL(file);
                      });
                      showToast('info', '正在上传二维码图片...');
                      try {
                        const result = await apiRequest<{ url: string }>('faq/upload-image', { method: 'POST', body: { data: dataUrl } });
                        setSettingsQrUrl(result.url);
                        showToast('success', '二维码图片已上传');
                      } catch (err) {
                        showToast('error', `上传失败: ${getErrorMessage(err)}`);
                      }
                      e.target.value = '';
                    }}
                  />
                  <button
                    className="button secondary small"
                    onClick={() => qrFileRef.current?.click()}
                    type="button"
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    📷 上传图片
                  </button>
                </div>
              </label>
            </div>
            {settingsQrUrl && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span className="muted" style={{ fontSize: '12px' }}>预览:</span>
                <img
                  src={settingsQrUrl}
                  alt="二维码预览"
                  style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: '8px', border: '1px solid var(--line)' }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="button"
                type="button"
                disabled={settingsSaving}
                onClick={async () => {
                  setSettingsSaving(true);
                  try {
                    await apiRequest('faq/settings', {
                      method: 'PATCH',
                      body: { contact_wechat: settingsWechat, contact_qrcode_url: settingsQrUrl },
                    });
                    showToast('success', '客服设置已保存');
                    setSettingsEditing(false);
                  } catch (err) {
                    showToast('error', getErrorMessage(err));
                  } finally {
                    setSettingsSaving(false);
                  }
                }}
              >
                {settingsSaving ? <><Spinner size={14} color="white" /> 保存中...</> : '💾 保存设置'}
              </button>
            </div>
          </div>
        )}
      </div>

      {faqs.length === 0 ? (
        <div className="faq-empty">暂无 FAQ，点击「新建 FAQ」添加。</div>
      ) : (
        <div className="panel-stack" style={{ gap: 8 }}>
          {faqs.map(faq => (
            <div key={faq.id} className={`faq-admin-row ${!faq.published ? "unpublished" : ""}`}>
              <div className="faq-admin-row-body">
                <div className="faq-admin-row-q">{faq.question}</div>
                <div className="faq-admin-row-meta">
                  <span>{faq.category}</span>
                  <span>·</span>
                  <span>排序: {faq.sortOrder}</span>
                  <span>·</span>
                  <span>{faq.published ? "✅ 已发布" : "⏸ 未发布"}</span>
                </div>
              </div>
              <div className="faq-admin-row-actions">
                <button className="button small secondary" onClick={() => startEdit(faq)} type="button">编辑</button>
                <button
                  className="button small secondary"
                  onClick={() => handleTogglePublish(faq)}
                  type="button"
                >
                  {faq.published ? "取消发布" : "发布"}
                </button>
                <button className="button small danger" onClick={() => handleDelete(faq.id)} type="button">删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
