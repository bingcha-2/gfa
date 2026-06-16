"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckIcon, PencilIcon, ArchiveIcon, GitMergeIcon, PlusIcon } from "lucide-react";

import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";

interface KnowledgeEntry {
  id: string;
  question: string;
  answer: string;
  category: string | null;
  status: string;
  mergeTargetId: string | null;
  sourceTicketId: string | null;
  usageCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const STATUS_TABS = [
  { value: "all", label: "全部" },
  { value: "DRAFT", label: "草稿待审" },
  { value: "MERGE_SUGGESTED", label: "合并建议" },
  { value: "PUBLISHED", label: "已发布" },
  { value: "ARCHIVED", label: "已归档" },
];

const STATUS_BADGE: Record<string, string> = {
  DRAFT: "草稿",
  MERGE_SUGGESTED: "合并建议",
  PUBLISHED: "已发布",
  ARCHIVED: "已归档",
};

export function SupportKnowledgePanel() {
  const [status, setStatus] = useState("all");
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<KnowledgeEntry | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await apiRequest<KnowledgeEntry[]>("support-knowledge", {
        search: { status: status === "all" ? undefined : status },
      });
      setEntries(rows);
      setSelected(new Set());
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function publish(id: string) {
    try {
      await apiRequest(`support-knowledge/${id}/publish`, { method: "POST" });
      toast.success("已发布");
      void load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  async function archive(id: string) {
    try {
      await apiRequest(`support-knowledge/${id}`, { method: "DELETE" });
      toast.success("已归档");
      void load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  function startCreate() {
    setEditing({
      id: "", // 空 id = 新增
      question: "",
      answer: "",
      category: "",
      status: "PUBLISHED",
      mergeTargetId: null,
      sourceTicketId: null,
      usageCount: 0,
      createdBy: "ADMIN",
      createdAt: "",
      updatedAt: "",
    });
  }

  async function saveEdit() {
    if (!editing) return;
    if (!editing.question.trim() || !editing.answer.trim()) {
      toast.info("问题和答案不能为空");
      return;
    }
    try {
      if (editing.id === "") {
        // 新增:直接发布
        await apiRequest("support-knowledge", {
          method: "POST",
          body: {
            question: editing.question,
            answer: editing.answer,
            category: editing.category ?? "",
            publish: true,
          },
        });
        toast.success("已新增并发布");
      } else {
        await apiRequest(`support-knowledge/${editing.id}`, {
          method: "PATCH",
          body: {
            question: editing.question,
            answer: editing.answer,
            category: editing.category ?? "",
          },
        });
        toast.success("已保存");
      }
      setEditing(null);
      void load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  async function mergeSelected() {
    const ids = [...selected];
    if (ids.length < 2) {
      toast.info("请勾选至少两条进行合并");
      return;
    }
    const [primaryId, ...otherIds] = ids;
    try {
      await apiRequest("support-knowledge/merge", {
        method: "POST",
        body: { primaryId, otherIds },
      });
      toast.success("已合并并发布到首条");
      void load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>客服知识库</CardTitle>
        <CardDescription>
          AI 客服的知识库。可手动「新增知识」直接录入,或由工单提炼成草稿;草稿/合并建议审核通过后,AI 客服才会使用。
        </CardDescription>
        <div className="mt-2 flex items-center gap-3">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_TABS.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected.size >= 2 && (
            <Button variant="outline" size="sm" onClick={mergeSelected}>
              <GitMergeIcon className="size-4" /> 合并所选({selected.size})
            </Button>
          )}
          <Button size="sm" className="ml-auto" onClick={startCreate}>
            <PlusIcon className="size-4" /> 新增知识
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : entries.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            暂无条目。去「工单」勾选有价值的工单点「提炼知识」即可生成草稿。
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>问题</TableHead>
                <TableHead className="w-24">分类</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="w-20">引用</TableHead>
                <TableHead className="w-48 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(e.id)}
                      onCheckedChange={() => toggle(e.id)}
                    />
                  </TableCell>
                  <TableCell className="max-w-sm">
                    <div className="font-medium">{e.question}</div>
                    <div className="line-clamp-2 text-xs text-muted-foreground">
                      {e.answer}
                    </div>
                  </TableCell>
                  <TableCell>{e.category || "—"}</TableCell>
                  <TableCell>
                    <Badge variant={e.status === "PUBLISHED" ? "default" : "secondary"}>
                      {STATUS_BADGE[e.status] ?? e.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{e.usageCount}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(e)}>
                        <PencilIcon className="size-4" />
                      </Button>
                      {(e.status === "DRAFT" || e.status === "MERGE_SUGGESTED") && (
                        <Button variant="ghost" size="sm" onClick={() => publish(e.id)}>
                          <CheckIcon className="size-4" /> 通过
                        </Button>
                      )}
                      {e.status !== "ARCHIVED" && (
                        <Button variant="ghost" size="sm" onClick={() => archive(e.id)}>
                          <ArchiveIcon className="size-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing?.id === "" ? "新增知识(直接发布)" : "编辑知识"}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground">问题</label>
                <Input
                  value={editing.question}
                  onChange={(ev) =>
                    setEditing({ ...editing, question: ev.target.value })
                  }
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">分类</label>
                <Input
                  value={editing.category ?? ""}
                  onChange={(ev) =>
                    setEditing({ ...editing, category: ev.target.value })
                  }
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">答案</label>
                <Textarea
                  rows={8}
                  value={editing.answer}
                  onChange={(ev) =>
                    setEditing({ ...editing, answer: ev.target.value })
                  }
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button onClick={saveEdit}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
