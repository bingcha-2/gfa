"use client";

import { useState, useEffect, useCallback } from "react";
import { apiRequest, getErrorMessage } from "@/lib/client-api";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Plus, Loader2, KeyRound, Shield, Pencil, Trash2, Lock } from "lucide-react";

type ManagedUser = {
  id: string; email: string; displayName: string; role: string;
  permissions: string[] | null; createdAt: string;
};

const ALL_PERMISSIONS = [
  { key: "overview", label: "总览" }, { key: "daily_stats", label: "数据汇总" },
  { key: "accounts", label: "母号池" }, { key: "groups", label: "家庭组" },
  { key: "orders", label: "订单" }, { key: "tasks", label: "任务" },
  { key: "codes", label: "卡密" }, { key: "expire", label: "到期扫描" },
  { key: "scheduler", label: "自动维护" }, { key: "lookup", label: "成员管理" },
  { key: "agent_service", label: "代理服务" },
];

const ROLE_LABELS: Record<string, string> = { SUPER_ADMIN: "超级管理员", ADMIN: "管理员", OPERATIONS: "运营", SUPPORT: "客服" };
const ROLE_COLORS: Record<string, string> = { SUPER_ADMIN: "bg-red-500", ADMIN: "bg-amber-500", OPERATIONS: "bg-emerald-500", SUPPORT: "bg-blue-500" };

export default function UsersPage() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ email: "", displayName: "", password: "", role: "ADMIN", permissions: [] as string[] });

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState("");
  const [editForm, setEditForm] = useState({ displayName: "", role: "", permissions: [] as string[] });

  // Reset password dialog
  const [resetOpen, setResetOpen] = useState(false);
  const [resetId, setResetId] = useState("");
  const [resetPw, setResetPw] = useState("");

  const loadUsers = useCallback(async () => {
    try { setLoading(true); const data = await apiRequest<ManagedUser[]>("users"); setUsers(data); }
    catch (err) { toast.error(getErrorMessage(err)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  async function handleCreate() {
    try {
      await apiRequest("users", { method: "POST", body: { ...createForm, permissions: createForm.permissions.length > 0 ? createForm.permissions : null } });
      toast.success(`用户 ${createForm.email} 创建成功`);
      setCreateOpen(false);
      setCreateForm({ email: "", displayName: "", password: "", role: "ADMIN", permissions: [] });
      await loadUsers();
    } catch (err) { toast.error(getErrorMessage(err)); }
  }

  async function handleUpdate() {
    try {
      await apiRequest(`users/${editId}`, { method: "PATCH", body: { displayName: editForm.displayName, role: editForm.role, permissions: editForm.permissions.length > 0 ? editForm.permissions : null } });
      toast.success("用户信息已更新");
      setEditOpen(false);
      await loadUsers();
    } catch (err) { toast.error(getErrorMessage(err)); }
  }

  async function handleResetPassword() {
    try {
      await apiRequest(`users/${resetId}/reset-password`, { method: "PATCH", body: { password: resetPw } });
      toast.success("密码已重置");
      setResetOpen(false); setResetPw("");
    } catch (err) { toast.error(getErrorMessage(err)); }
  }

  async function handleDelete(id: string, email: string) {
    try {
      await apiRequest(`users/${id}`, { method: "DELETE" });
      toast.success(`用户 ${email} 已删除`);
      await loadUsers();
    } catch (err) { toast.error(getErrorMessage(err)); }
  }

  function togglePerm(perms: string[], key: string) {
    return perms.includes(key) ? perms.filter((p) => p !== key) : [...perms, key];
  }

  function PermCheckboxes({ perms, onChange }: { perms: string[]; onChange: (p: string[]) => void }) {
    return (
      <div className="grid grid-cols-2 gap-2 mt-2">
        {ALL_PERMISSIONS.map((p) => (
          <div key={p.key} className="flex items-center gap-2">
            <Checkbox id={`perm-${p.key}`} checked={perms.includes(p.key)} onCheckedChange={() => onChange(togglePerm(perms, p.key))} />
            <Label htmlFor={`perm-${p.key}`} className="text-sm cursor-pointer">{p.label}</Label>
          </div>
        ))}
      </div>
    );
  }

  if (loading) return <div className="space-y-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div>;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>用户管理</CardTitle>
              <CardDescription>管理控制台管理员账号和权限分配</CardDescription>
            </div>
            <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4 mr-2" />创建用户</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {users.map((u) => (
            <div key={u.id} className="flex items-center justify-between p-4 rounded-lg border">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{u.displayName}</span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium text-white ${ROLE_COLORS[u.role] ?? "bg-gray-500"}`}>
                    {ROLE_LABELS[u.role] ?? u.role}
                  </span>
                </div>
                <div className="text-sm text-muted-foreground">{u.email}</div>
                {u.permissions && u.permissions.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {u.permissions.map((p) => (
                      <Badge key={p} variant="secondary" className="text-xs">{ALL_PERMISSIONS.find((ap) => ap.key === p)?.label ?? p}</Badge>
                    ))}
                  </div>
                )}
                {(!u.permissions || u.permissions.length === 0) && u.role !== "SUPER_ADMIN" && (
                  <div className="text-xs text-muted-foreground mt-1">全部权限</div>
                )}
                <div className="text-xs text-muted-foreground">创建于 {new Date(u.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</div>
              </div>
              {u.role !== "SUPER_ADMIN" && (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => { setEditId(u.id); setEditForm({ displayName: u.displayName, role: u.role, permissions: u.permissions ?? [] }); setEditOpen(true); }}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { setResetId(u.id); setResetOpen(true); }}>
                    <Lock className="h-3.5 w-3.5" />
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="text-destructive" />}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>确认删除？</AlertDialogTitle>
                        <AlertDialogDescription>确认删除用户 {u.email}？此操作不可恢复。</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void handleDelete(u.id, u.email)}>确认删除</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Create User Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>创建用户</DialogTitle><DialogDescription>添加新的控制台管理员</DialogDescription></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>邮箱</Label><Input type="email" value={createForm.email} onChange={(e) => setCreateForm((p) => ({ ...p, email: e.target.value }))} className="mt-1" /></div>
              <div><Label>显示名</Label><Input value={createForm.displayName} onChange={(e) => setCreateForm((p) => ({ ...p, displayName: e.target.value }))} className="mt-1" /></div>
              <div><Label>密码</Label><Input type="password" minLength={6} value={createForm.password} onChange={(e) => setCreateForm((p) => ({ ...p, password: e.target.value }))} className="mt-1" /></div>
              <div><Label>角色</Label>
                <Select value={createForm.role} onValueChange={(v) => setCreateForm((p) => ({ ...p, role: v }))} items={[
                  { label: "管理员", value: "ADMIN" },
                  { label: "运营", value: "OPERATIONS" },
                  { label: "客服", value: "SUPPORT" },
                ]}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup><SelectItem value="ADMIN">管理员</SelectItem><SelectItem value="OPERATIONS">运营</SelectItem><SelectItem value="SUPPORT">客服</SelectItem></SelectGroup></SelectContent>
                </Select>
              </div>
            </div>
            <div><Label>权限模块（留空 = 所有权限）</Label><PermCheckboxes perms={createForm.permissions} onChange={(p) => setCreateForm((f) => ({ ...f, permissions: p }))} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button onClick={() => void handleCreate()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>编辑用户</DialogTitle></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>显示名</Label><Input value={editForm.displayName} onChange={(e) => setEditForm((p) => ({ ...p, displayName: e.target.value }))} className="mt-1" /></div>
              <div><Label>角色</Label>
                <Select value={editForm.role} onValueChange={(v) => setEditForm((p) => ({ ...p, role: v }))} items={[
                  { label: "管理员", value: "ADMIN" },
                  { label: "运营", value: "OPERATIONS" },
                  { label: "客服", value: "SUPPORT" },
                ]}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup><SelectItem value="ADMIN">管理员</SelectItem><SelectItem value="OPERATIONS">运营</SelectItem><SelectItem value="SUPPORT">客服</SelectItem></SelectGroup></SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Label>权限模块</Label>
                <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setEditForm((p) => ({ ...p, permissions: ALL_PERMISSIONS.map((pp) => pp.key) }))}>全选</Button>
                <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setEditForm((p) => ({ ...p, permissions: [] }))}>清空</Button>
              </div>
              <PermCheckboxes perms={editForm.permissions} onChange={(p) => setEditForm((f) => ({ ...f, permissions: p }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>取消</Button>
            <Button onClick={() => void handleUpdate()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>重置密码</DialogTitle></DialogHeader>
          <div className="py-4">
            <Label>新密码（至少 6 位）</Label>
            <Input type="password" minLength={6} value={resetPw} onChange={(e) => setResetPw(e.target.value)} className="mt-2" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setResetOpen(false); setResetPw(""); }}>取消</Button>
            <Button onClick={() => void handleResetPassword()} disabled={resetPw.length < 6}>确认重置</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
