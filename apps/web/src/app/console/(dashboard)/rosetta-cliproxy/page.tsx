"use client";

import { useCallback, useEffect, useState, useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { apiRequest, getErrorMessage } from "@/lib/client-api";
import { 
  ChevronLeftIcon, 
  ChevronRightIcon, 
  RefreshCwIcon, 
  BotIcon, 
  ServerIcon,
  CheckCircle2Icon,
  XCircleIcon,
  ShieldCheckIcon,
  ShieldAlertIcon,
  SendIcon,
  FileTextIcon
} from "lucide-react";

interface AgentAccount {
  id: string;
  loginEmail: string;
  loginPassword: string;
  totpSecret: string | null;
  recoveryEmail: string | null;
  status: "REGISTERED" | "PHONE_VERIFIED" | "IN_GROUP" | "UPLOADED" | "REMOVED";
  refreshToken: string | null;
  tokenObtainedAt: string | null;
  familyGroupId: string | null;
  uploadedAt: string | null;
  removedAt: string | null;
  lastTaskId: string | null;
  notes: string | null;
  pool: "pending" | "no_ban" | "ban_risk";
  banned: boolean;
  uploadedToPool: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CLIProxyStatus {
  connected: boolean;
  baseUrl: string;
  files: string[];
  error?: string;
}

export default function RosettaCliProxyPage() {
  // CLIProxy Connection Status
  const [proxyStatus, setProxyStatus] = useState<CLIProxyStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  // Accounts List
  const [accounts, setAccounts] = useState<AgentAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(30);
  const [totalAccounts, setTotalAccounts] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  // Batch Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Credentials Configuration
  const [useCustomCreds, setUseCustomCreds] = useState(false);
  const [clientId, setClientId] = useState(
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
  );
  const [clientSecret, setClientSecret] = useState("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");

  // Actions
  const [uploading, setUploading] = useState(false);

  // Load status of the CLIProxy server
  const loadProxyStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const data = await apiRequest<CLIProxyStatus>("agent-accounts/cliproxy-status");
      setProxyStatus(data);
    } catch (err) {
      toast.error(`获取 CLIProxy 状态失败: ${getErrorMessage(err)}`);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  // Load child accounts from local GFA database
  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    try {
      const search: any = { page, pageSize };
      if (statusFilter !== "all") {
        search.status = statusFilter;
      }
      const data = await apiRequest<{ items: AgentAccount[]; total: number; totalPages: number }>(
        "agent-accounts",
        { search }
      );
      setAccounts(data.items);
      setTotalAccounts(data.total);
      setTotalPages(data.totalPages);
    } catch (err) {
      toast.error(`加载子号列表失败: ${getErrorMessage(err)}`);
    } finally {
      setAccountsLoading(false);
    }
  }, [page, pageSize, statusFilter]);

  // Initial load
  useEffect(() => {
    loadProxyStatus();
  }, [loadProxyStatus]);

  // Load accounts when pagination or filter changes
  useEffect(() => {
    loadAccounts();
    setSelectedIds(new Set()); // Reset selections when page/filter changes
  }, [loadAccounts]);

  // Filter accounts list locally by search query
  const filteredAccounts = useMemo(() => {
    if (!searchQuery.trim()) return accounts;
    const q = searchQuery.toLowerCase().trim();
    return accounts.filter(
      (acc) =>
        acc.loginEmail.toLowerCase().includes(q) ||
        (acc.notes && acc.notes.toLowerCase().includes(q))
    );
  }, [accounts, searchQuery]);

  // Selection handlers
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const uploadableIds = filteredAccounts
        .filter((acc) => acc.refreshToken && !acc.banned)
        .map((acc) => acc.id);
      setSelectedIds(new Set(uploadableIds));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleSelectOne = (id: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) {
      next.add(id);
    } else {
      next.delete(id);
    }
    setSelectedIds(next);
  };

  // Perform upload
  const handleBatchUpload = async () => {
    if (selectedIds.size === 0) {
      toast.error("请先勾选需要上号的子号");
      return;
    }

    setUploading(true);
    const body: { ids: string[]; clientId?: string; clientSecret?: string } = {
      ids: Array.from(selectedIds),
    };

    if (useCustomCreds) {
      if (!clientId.trim() || !clientSecret.trim()) {
        toast.error("启用自定义凭证时，Client ID 和 Client Secret 不能为空");
        setUploading(false);
        return;
      }
      body.clientId = clientId.trim();
      body.clientSecret = clientSecret.trim();
    }

    try {
      const result = await apiRequest<{
        total: number;
        added: number;
        updated: number;
        failed: number;
        errors: Array<{ email: string; error: string }>;
      }>("agent-accounts/upload-cliproxy", {
        method: "POST",
        body,
      });

      if (result.failed > 0) {
        toast.error(
          `上号完成，但有部分失败：新增 ${result.added} 个，更新 ${result.updated} 个，失败 ${result.failed} 个`
        );
        for (const e of result.errors.slice(0, 5)) {
          toast.error(`${e.email}: ${e.error}`);
        }
      } else {
        toast.success(`上号成功！新增 ${result.added} 个，更新 ${result.updated} 个`);
      }

      setSelectedIds(new Set());
      loadAccounts();
      loadProxyStatus();
    } catch (err) {
      toast.error(`上号请求失败: ${getErrorMessage(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const getStatusBadge = (status: AgentAccount["status"]) => {
    switch (status) {
      case "UPLOADED":
        return <Badge className="bg-emerald-600 hover:bg-emerald-700 text-white border-none">已上号 (UPLOADED)</Badge>;
      case "IN_GROUP":
        return <Badge className="bg-blue-600 hover:bg-blue-700 text-white border-none">已进组 (IN_GROUP)</Badge>;
      case "PHONE_VERIFIED":
        return <Badge className="bg-indigo-600 hover:bg-indigo-700 text-white border-none">已手机验证 (PHONE_VERIFIED)</Badge>;
      case "REGISTERED":
        return <Badge variant="secondary">已注册 (REGISTERED)</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="flex flex-col gap-6 p-4">
      {/* Title Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">CLIProxy 远程上号管理</h1>
        <p className="text-sm text-muted-foreground">
          将本机获取的 Antigravity 子号凭证（包含 Refresh Token）批量上传并同步到远程 CLIProxyAPI 服务器。
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {/* Connection Status Card */}
        <Card className="md:col-span-1 border border-border/80 shadow-md">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <ServerIcon className="size-5 text-indigo-500" />
              <CardTitle className="text-base font-medium">CLIProxy 服务端状态</CardTitle>
            </div>
            <CardDescription>配置于系统环境变量中的远程服务器连接状态</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {statusLoading ? (
              <div className="flex items-center justify-center py-4">
                <Spinner size={16} />
              </div>
            ) : proxyStatus ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">连接状态:</span>
                  {proxyStatus.connected ? (
                    <Badge className="bg-emerald-500 hover:bg-emerald-600 border-none gap-1 py-1">
                      <CheckCircle2Icon className="size-3.5" /> 已连接
                    </Badge>
                  ) : (
                    <Badge variant="destructive" className="gap-1 py-1">
                      <XCircleIcon className="size-3.5" /> 连接失败
                    </Badge>
                  )}
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">服务端地址 (CLIPROXY_BASE_URL)</span>
                  <code className="text-xs font-mono bg-muted p-2 rounded truncate border border-border">
                    {proxyStatus.baseUrl || "未配置"}
                  </code>
                </div>

                {proxyStatus.error && (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-destructive font-medium">错误信息</span>
                    <p className="text-xs text-red-500 bg-red-50 dark:bg-red-950/20 p-2 rounded border border-red-200 dark:border-red-900/50 break-all leading-normal">
                      {proxyStatus.error}
                    </p>
                  </div>
                )}

                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground font-medium">已加载凭证文件</span>
                    <Badge variant="outline" className="font-mono text-xs">
                      {proxyStatus.files?.length || 0}
                    </Badge>
                  </div>
                  {proxyStatus.files && proxyStatus.files.length > 0 ? (
                    <div className="max-h-[140px] overflow-y-auto border border-border rounded-md mt-1 divide-y divide-border">
                      {proxyStatus.files.map((file, idx) => (
                        <div key={idx} className="flex items-center gap-1.5 p-2 font-mono text-[10px] truncate hover:bg-muted/30">
                          <FileTextIcon className="size-3 text-muted-foreground shrink-0" />
                          <span className="truncate">{file}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground text-center py-6 border border-dashed rounded-md mt-1">
                      暂无凭证文件
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground text-center py-4">
                获取状态数据为空
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={loadProxyStatus}
              disabled={statusLoading}
              className="mt-2 w-full gap-1"
            >
              <RefreshCwIcon className={`size-3.5 ${statusLoading ? "animate-spin" : ""}`} />
              重新检查连接
            </Button>
          </CardContent>
        </Card>

        {/* Credentials Form Card */}
        <Card className="md:col-span-2 border border-border/80 shadow-md">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <BotIcon className="size-5 text-indigo-500" />
              <CardTitle className="text-base font-medium">OAuth 凭证选择</CardTitle>
            </div>
            <CardDescription>
              选择上号至 CLIProxy 时所使用的 Google Cloud 客户端凭证。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4">
              <div className="flex items-center justify-between">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">使用自定义客户端凭证</span>
                  <span className="text-xs text-muted-foreground">
                    若关闭，将默认使用内置的谷歌 Cloud SDK 官方凭证
                  </span>
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="custom-creds-toggle"
                    className="size-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                    checked={useCustomCreds}
                    onChange={(e) => setUseCustomCreds(e.target.checked)}
                  />
                  <label htmlFor="custom-creds-toggle" className="ml-2 text-sm font-medium cursor-pointer select-none">
                    自定义
                  </label>
                </div>
              </div>

              {useCustomCreds && (
                <div className="grid gap-3 pt-3 border-t border-border mt-2 animate-in fade-in duration-200">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-semibold text-muted-foreground">Client ID</label>
                    <Input
                      placeholder="输入谷歌 OAuth Client ID"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-semibold text-muted-foreground">Client Secret</label>
                    <Input
                      type="password"
                      placeholder="输入谷歌 OAuth Client Secret"
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="text-[11px] text-amber-600 dark:text-amber-500 bg-amber-50 dark:bg-amber-950/20 p-2.5 rounded border border-amber-200 dark:border-amber-900/50 flex items-start gap-1.5 mt-1 leading-normal">
                    <ShieldAlertIcon className="size-4 shrink-0 text-amber-500 mt-0.5" />
                    <span>
                      注意：项目 ID 探测接口（discoverProjectId）会使用该凭证获取 Access Token。请确保您填写的凭证拥有对该子号进行授权的权限范围（Scopes）。
                    </span>
                  </div>
                </div>
              )}

              {!useCustomCreds && (
                <div className="text-xs text-muted-foreground bg-muted/50 p-3 rounded-md border border-border/50 flex items-start gap-2 leading-relaxed">
                  <ShieldCheckIcon className="size-4 text-emerald-500 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold text-foreground">当前运行模式：系统默认官方凭证</span>
                    <p className="mt-1">
                      将使用内置的官方 Google SDK Client ID 进行凭证配置和项目名探测。此模式无需手动填写，通常能最高效兼容大部分录入子号。
                    </p>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Accounts List Section */}
      <Card className="border border-border/80 shadow-md">
        <CardHeader className="flex flex-row items-center justify-between pb-3 gap-4">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-lg font-semibold">可用子号池列表</CardTitle>
            <CardDescription>选择需要同步上传的子号，支持批量上传</CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <Input
              placeholder="搜索账号邮箱..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-56 h-9 text-xs"
            />
            <Button
              onClick={handleBatchUpload}
              disabled={selectedIds.size === 0 || uploading}
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium h-9 gap-1 text-xs px-3"
            >
              {uploading ? (
                <Spinner data-icon className="size-3.5" />
              ) : (
                <SendIcon className="size-3.5" />
              )}
              批量上号 到 CLIProxy ({selectedIds.size})
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Status Tabs */}
          <div className="flex border-b border-border gap-2">
            {[
              { id: "all", label: "全部" },
              { id: "PHONE_VERIFIED", label: "已手机验证" },
              { id: "IN_GROUP", label: "已进组" },
              { id: "UPLOADED", label: "已上号" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setStatusFilter(tab.id);
                  setPage(1);
                }}
                className={`px-4 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
                  statusFilter === tab.id
                    ? "border-indigo-600 text-indigo-600 dark:text-indigo-400"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {accountsLoading ? (
            <div className="flex justify-center items-center py-16">
              <Spinner size={32} />
            </div>
          ) : filteredAccounts.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-16 border border-dashed rounded-md">
              {searchQuery ? "未搜索到匹配的子号" : "暂无匹配的子号数据"}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12 text-center">
                      <input
                        type="checkbox"
                        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer size-3.5"
                        checked={
                          filteredAccounts.length > 0 &&
                          filteredAccounts
                            .filter((a) => a.refreshToken && !a.banned)
                            .every((a) => selectedIds.has(a.id))
                        }
                        onChange={(e) => handleSelectAll(e.target.checked)}
                      />
                    </TableHead>
                    <TableHead>子号邮箱</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>凭证状态</TableHead>
                    <TableHead>上号池</TableHead>
                    <TableHead>防封池</TableHead>
                    <TableHead>备注</TableHead>
                    <TableHead>创建时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAccounts.map((acc) => {
                    const hasToken = !!acc.refreshToken;
                    const isSelectable = hasToken && !acc.banned;
                    return (
                      <TableRow
                        key={acc.id}
                        className={`hover:bg-muted/40 ${
                          acc.banned ? "opacity-60 bg-red-50/20 dark:bg-red-950/5" : ""
                        }`}
                      >
                        <TableCell className="text-center">
                          <input
                            type="checkbox"
                            disabled={!isSelectable}
                            checked={selectedIds.has(acc.id)}
                            onChange={(e) => handleSelectOne(acc.id, e.target.checked)}
                            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer disabled:cursor-not-allowed size-3.5"
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs font-medium">
                          <div className="flex flex-col">
                            <span>{acc.loginEmail}</span>
                            {acc.banned && (
                              <span className="text-[10px] text-red-500 font-semibold mt-0.5">
                                [已标记封号]
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{getStatusBadge(acc.status)}</TableCell>
                        <TableCell>
                          {hasToken ? (
                            <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium bg-emerald-50 dark:bg-emerald-950/20 px-2 py-0.5 rounded border border-emerald-100 dark:border-emerald-900/30">
                              含有 Refresh Token
                            </span>
                          ) : (
                            <span className="text-xs text-amber-600 dark:text-amber-500 font-medium bg-amber-50 dark:bg-amber-950/20 px-2 py-0.5 rounded border border-amber-100 dark:border-amber-900/30">
                              无 Token (不可上传)
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-xs">
                            {acc.uploadedToPool || "-"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {acc.pool === "no_ban" ? (
                            <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 border-none font-normal">
                              no_ban
                            </Badge>
                          ) : acc.pool === "ban_risk" ? (
                            <Badge className="bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300 border-none font-normal">
                              ban_risk
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="font-normal">
                              pending
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[180px] truncate">
                          {acc.notes || "-"}
                        </TableCell>
                        <TableCell className="text-xs font-mono text-muted-foreground">
                          {acc.createdAt ? new Date(acc.createdAt).toLocaleString() : "-"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Pagination Footer */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-4 border-t border-border">
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeftIcon className="size-4" />
              </Button>
              <span className="text-xs text-muted-foreground font-medium">
                第 {page} / {totalPages} 页 (共 {totalAccounts} 条记录)
              </span>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRightIcon className="size-4" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
