"use client";

import { useState } from "react";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Search, Loader2, UserMinus, RotateCcw, ArrowLeftRight } from "lucide-react";

type LookupResult = {
  found: boolean; error?: string; memberStatus?: string;
  member?: { id: string; displayName: string | null; joinedAt: string | null; expiresAt: string | null };
  familyGroup?: { id: string; groupName: string; accountEmail: string | null; status: string; memberCount: number; maxMembers: number };
  order?: { id: string; orderNo: string; status: string; code: string | null; codeType: string | null; expiresAt: string | null; createdAt: string };
};

function fmtDate(iso: string | null | undefined) { return iso ? new Date(iso).toLocaleDateString("zh-CN") : "—"; }
function fmtDateTime(iso: string | null | undefined) { return iso ? new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"; }
function isExpired(iso: string | null | undefined) { return iso ? new Date(iso) < new Date() : false; }

function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (["COMPLETED", "INVITE_SENT", "SUCCESS", "ACTIVE"].includes(s)) return "default";
  if (["PENDING", "RUNNING"].includes(s)) return "secondary";
  if (["FAILED", "CANCELLED"].includes(s)) return "destructive";
  return "outline";
}

const CODE_TYPE_LABELS: Record<string, string> = { JOIN_GROUP: "加入家庭组", ACCOUNT_SWAP: "账号换绑" };

export default function LookupPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Replace
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceNew, setReplaceNew] = useState("");

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = email.trim();
    if (!q) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const data = await apiRequest<LookupResult>(`family-groups/lookup-by-member?email=${encodeURIComponent(q)}`);
      setResult(data);
    } catch (err) { setError(getErrorMessage(err)); }
    finally { setLoading(false); }
  }

  async function handleRemove() {
    if (!result?.familyGroup) return;
    setActionLoading("remove");
    try {
      await apiRequest(`family-groups/${result.familyGroup.id}/remove-member`, { method: "POST", body: { memberEmail: email.trim() } });
      toast.success(`已提交移除任务: ${email.trim()}`);
      await handleSearch({ preventDefault: () => {} } as React.FormEvent);
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setActionLoading(null); }
  }

  async function handleRetry() {
    if (!result?.order) return;
    setActionLoading("retry");
    try {
      await apiRequest(`orders/${result.order.id}/retry`, { method: "POST" });
      toast.success(`已提交重试: ${result.order.orderNo}`);
      await handleSearch({ preventDefault: () => {} } as React.FormEvent);
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setActionLoading(null); }
  }

  async function handleReplace() {
    if (!result?.order || !replaceNew.trim()) return;
    setActionLoading("replace");
    try {
      await apiRequest(`orders/${result.order.id}/replace-member`, {
        method: "POST", body: { targetMemberEmail: email.trim().toLowerCase(), newUserEmail: replaceNew.trim().toLowerCase() },
      });
      toast.success(`替换任务已提交`);
      setReplaceOpen(false); setReplaceNew("");
      await handleSearch({ preventDefault: () => {} } as React.FormEvent);
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setActionLoading(null); }
  }

  const expired = result?.order ? isExpired(result.order.expiresAt) : false;

  return (
    <div className="space-y-6">
      {/* Search */}
      <Card>
        <CardHeader>
          <CardTitle>成员管理</CardTitle>
          <CardDescription>输入客户邮箱，查看完整信息并执行管理操作</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSearch} className="flex gap-3">
            <div className="flex-1">
              <Input type="email" placeholder="customer@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={loading} />
            </div>
            <Button type="submit" disabled={loading || !email.trim()}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Search className="h-4 w-4 mr-2" />}
              查询
            </Button>
          </form>
        </CardContent>
      </Card>

      {error && <Card className="border-destructive"><CardContent className="pt-6 text-destructive text-sm">{error}</CardContent></Card>}

      {result && (
        result.found ? (
          <>
            {/* Status + Actions bar */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">{email}</CardTitle>
                    {result.member?.displayName && <CardDescription>{result.member.displayName}</CardDescription>}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Badge variant={statusVariant(result.memberStatus === "ACTIVE" ? "ACTIVE" : result.memberStatus === "NO_MEMBER_RECORD" ? "PENDING" : result.memberStatus ?? "UNKNOWN")}>
                      {result.memberStatus === "ACTIVE" ? "活跃" : result.memberStatus === "NO_MEMBER_RECORD" ? "未入组" : result.memberStatus}
                    </Badge>
                    {result.member?.expiresAt && (
                      <span className={`text-xs font-medium ${isExpired(result.member.expiresAt) ? "text-destructive" : "text-emerald-500"}`}>
                        到期：{fmtDate(result.member.expiresAt)}{isExpired(result.member.expiresAt) && " ⚠ 已到期"}
                      </span>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2 flex-wrap">
                  {result.familyGroup && (result.memberStatus === "ACTIVE" || result.memberStatus === "PENDING") && (
                    <AlertDialog>
                      <AlertDialogTrigger render={<Button variant="outline" size="sm" className="text-destructive gap-1" disabled={actionLoading !== null} />}>
                        <UserMinus className="h-3.5 w-3.5" />移除成员
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>确认移除？</AlertDialogTitle>
                          <AlertDialogDescription>将 {email} 从 {result.familyGroup.groupName} 中移除。</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>取消</AlertDialogCancel>
                          <AlertDialogAction onClick={() => void handleRemove()}>确认移除</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                  {result.order && ["MANUAL_REVIEW", "FAILED"].includes(result.order.status) && (
                    <AlertDialog>
                      <AlertDialogTrigger render={<Button variant="outline" size="sm" className="text-amber-500 gap-1" disabled={actionLoading !== null} />}>
                        <RotateCcw className="h-3.5 w-3.5" />重试订单
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader><AlertDialogTitle>确认重试？</AlertDialogTitle></AlertDialogHeader>
                        <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void handleRetry()}>确认重试</AlertDialogAction></AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                  {result.order && (
                    <Button variant="outline" size="sm" className="gap-1" onClick={() => setReplaceOpen(true)} disabled={actionLoading !== null}>
                      <ArrowLeftRight className="h-3.5 w-3.5" />替换成员
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Info cards */}
            <div className="grid gap-6 md:grid-cols-2">
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-sm">家庭组</CardTitle></CardHeader>
                <CardContent>
                  {result.familyGroup ? (
                    <div className="space-y-2 text-sm">
                      <div className="flex items-center gap-2"><span className="font-medium">{result.familyGroup.groupName}</span><Badge variant={statusVariant(result.familyGroup.status)} className="text-xs">{result.familyGroup.status}</Badge></div>
                      {result.familyGroup.accountEmail && <div className="text-muted-foreground">母号：{result.familyGroup.accountEmail}</div>}
                      <div className="text-muted-foreground">成员：{result.familyGroup.memberCount} / {result.familyGroup.maxMembers}</div>
                    </div>
                  ) : <p className="text-muted-foreground text-sm">未关联家庭组</p>}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-sm">订单 / 卡密</CardTitle></CardHeader>
                <CardContent>
                  {result.order ? (
                    <div className="space-y-2 text-sm">
                      <div className="flex items-center gap-2"><span className="font-mono font-medium">{result.order.orderNo}</span><Badge variant={statusVariant(result.order.status)} className="text-xs">{result.order.status}</Badge></div>
                      <div className="text-muted-foreground">卡密：<code className="bg-muted px-1.5 py-0.5 rounded text-xs">{result.order.code ?? "—"}</code></div>
                      {result.order.codeType && <div className="text-muted-foreground">类型：{CODE_TYPE_LABELS[result.order.codeType] ?? result.order.codeType}</div>}
                      <div className="text-muted-foreground">创建：{fmtDateTime(result.order.createdAt)}</div>
                      <div className={expired ? "text-destructive font-medium" : "text-muted-foreground"}>
                        到期：{fmtDate(result.order.expiresAt)}{expired && " ⚠ 已到期"}
                      </div>
                    </div>
                  ) : <p className="text-muted-foreground text-sm">未找到关联订单</p>}
                </CardContent>
              </Card>
            </div>

            {/* Replace dialog */}
            <Dialog open={replaceOpen} onOpenChange={setReplaceOpen}>
              <DialogContent>
                <DialogHeader><DialogTitle>替换成员</DialogTitle><DialogDescription>{email} → 新成员</DialogDescription></DialogHeader>
                <div className="py-4"><Label>新成员邮箱</Label><Input type="email" placeholder="new-member@gmail.com" value={replaceNew} onChange={(e) => setReplaceNew(e.target.value)} className="mt-2" /></div>
                <DialogFooter><Button variant="outline" onClick={() => setReplaceOpen(false)}>取消</Button><Button onClick={() => void handleReplace()} disabled={!replaceNew.trim()}>确认替换</Button></DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <Search className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="font-semibold text-lg">未找到记录</p>
              <p className="text-muted-foreground text-sm mt-1">{email} 不在任何家庭组中，或尚未兑换卡密。</p>
            </CardContent>
          </Card>
        )
      )}
    </div>
  );
}
