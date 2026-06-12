"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Megaphone, Save, Trash2, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

export default function AnnouncementPage() {
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchAnnouncement = useCallback(async () => {
    try {
      const res = await fetch("/api/app/lease/antigravity/announcement");
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
      const res = await fetch("/api/app/lease/antigravity/announcement", {
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
      const res = await fetch("/api/app/lease/antigravity/announcement", {
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
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Megaphone className="h-6 w-6" />
          公告管理
        </h1>
        <p className="text-muted-foreground mt-1">
          管理客户端顶部滚动公告。留空则不显示公告条。
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>客户端公告</CardTitle>
          <CardDescription>公告将在客户端顶部以滚动字幕形式展示，客户端每 5 分钟刷新一次。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="announcement-text" className="mb-2">公告内容</Label>
            {loading ? (
              <Skeleton className="h-[120px] w-full" />
            ) : (
              <Textarea
                id="announcement-text"
                className="min-h-[120px] resize-y"
                placeholder="输入公告内容（留空隐藏公告条）..."
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={saving}
              />
            )}
            <p className="text-xs text-muted-foreground mt-1">
              保存空内容会隐藏公告条。
            </p>
          </div>

          {savedText && (
            <div className="rounded-lg bg-muted/50 p-3">
              <p className="text-xs font-medium text-muted-foreground mb-1">当前线上公告：</p>
              <p className="text-sm">{savedText || <span className="text-muted-foreground italic">（无）</span>}</p>
            </div>
          )}

          <div className="flex gap-3">
            <Button
              type="button"
              onClick={handleSave}
              disabled={saving || loading || !isDirty}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              保存公告
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleClear}
              disabled={saving || loading || !savedText}
            >
              <Trash2 className="h-4 w-4" />
              清除公告
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
