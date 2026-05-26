"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";

export default function AnnouncementPage() {
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchAnnouncement = useCallback(async () => {
    try {
      const res = await fetch("/api/remote-token/announcement");
      const content = await res.text();
      setText(content);
      setSavedText(content);
    } catch {
      toast.error("加载公告失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAnnouncement();
  }, [fetchAnnouncement]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/remote-token/announcement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setSavedText(text.trim());
      toast.success("公告已保存");
    } catch (err: any) {
      toast.error("保存失败: " + (err.message || err));
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/remote-token/announcement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "" }),
      });
      if (!res.ok) throw new Error("Failed");
      setText("");
      setSavedText("");
      toast.success("公告已清除");
    } catch {
      toast.error("清除失败");
    } finally {
      setSaving(false);
    }
  };

  const isDirty = text.trim() !== savedText;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">📢 公告管理</h1>
        <p className="text-muted-foreground mt-1">
          管理客户端顶部滚动公告。留空则不显示公告条。
        </p>
      </div>

      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div>
          <label className="text-sm font-medium mb-2 block">公告内容</label>
          <textarea
            className="w-full min-h-[120px] rounded-lg border border-input bg-transparent px-3 py-2 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 resize-y"
            placeholder="输入公告内容（留空隐藏公告条）..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={loading}
          />
          <p className="text-xs text-muted-foreground mt-1">
            公告将在客户端顶部以滚动字幕形式展示，客户端每 5 分钟刷新一次。
          </p>
        </div>

        {savedText && (
          <div className="rounded-lg bg-muted/50 p-3">
            <p className="text-xs font-medium text-muted-foreground mb-1">当前线上公告：</p>
            <p className="text-sm">{savedText || <span className="text-muted-foreground italic">（无）</span>}</p>
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={handleSave}
            disabled={saving || loading || !isDirty}
            className="inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground h-9 px-4 text-sm font-medium transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
          >
            {saving ? "保存中..." : "保存公告"}
          </button>
          <button
            onClick={handleClear}
            disabled={saving || loading || !savedText}
            className="inline-flex items-center justify-center rounded-lg border border-input bg-background h-9 px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:pointer-events-none"
          >
            清除公告
          </button>
        </div>
      </div>
    </div>
  );
}
