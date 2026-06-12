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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
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

interface RosettaAccount {
  id: number;
  email: string;
  enabled: boolean;
  poolEnabled: boolean;
  alias: string;
  projectId: string;
  planType: string;
  hasToken: boolean;
}

interface CLIProxyStatus {
  connected: boolean;
  baseUrl: string;
  files: any[];
  error?: string;
}

export default function RosettaCliProxyPage() {
  // CLIProxy Connection Status
  const [proxyStatus, setProxyStatus] = useState<CLIProxyStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [uploadProvider, setUploadProvider] = useState<"gemini" | "antigravity">("gemini");

  // Accounts List
  const [accounts, setAccounts] = useState<RosettaAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(30);

  // Batch Selection
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Credentials Configuration
  const [presetType, setPresetType] = useState<"google_sdk" | "wails_client" | "custom">("google_sdk");
  const [useCustomCreds, setUseCustomCreds] = useState(false);
  const [clientId, setClientId] = useState(
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
  );
  const [clientSecret, setClientSecret] = useState("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");

  useEffect(() => {
    if (presetType === "google_sdk") {
      setUseCustomCreds(false);
      setClientId("1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com");
      setClientSecret("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");
    } else if (presetType === "wails_client") {
      setUseCustomCreds(true);
      setClientId("681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com");
      setClientSecret("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");
    } else if (presetType === "custom") {
      setUseCustomCreds(true);
    }
  }, [presetType]);

  // Actions
  const [uploading, setUploading] = useState(false);

  // Load status of the CLIProxy server
  const loadProxyStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const data = await apiRequest<CLIProxyStatus>("rosetta/cliproxy-status");
      if (data && data.files) {
        if (!Array.isArray(data.files) && typeof data.files === "object" && Array.isArray((data.files as any).files)) {
          data.files = (data.files as any).files;
        }
      }
      setProxyStatus(data);
    } catch (err) {
      toast.error(`获取 CLIProxy 状态失败: ${getErrorMessage(err)}`);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  // Load child accounts from local Rosetta accounts.json
  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    try {
      const data = await apiRequest<{ accounts: RosettaAccount[] }>("rosetta/accounts");
      setAccounts(data?.accounts || []);
    } catch (err) {
      toast.error(`加载 Rosetta 账号列表失败: ${getErrorMessage(err)}`);
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadProxyStatus();
    loadAccounts();
  }, [loadProxyStatus, loadAccounts]);

  // Reset selectedIds when filter changes
  useEffect(() => {
    setSelectedIds(new Set());
  }, [statusFilter]);

  const isUploaded = useCallback((email: string, provider?: "gemini" | "antigravity") => {
    if (!proxyStatus?.files || !email) return false;
    const lowerEmail = email.toLowerCase();
    const targetProvider = provider || uploadProvider;
    return proxyStatus.files.some(file => {
      if (!file) return false;
      const fileName = String(typeof file === "string" ? file : (file.name || file.email || ""));
      const lowerFile = fileName.toLowerCase();
      if (targetProvider === "gemini") {
        return lowerFile.startsWith("gemini-") && lowerFile.includes(lowerEmail);
      } else {
        return lowerFile.startsWith("antigravity-") && lowerFile.includes(lowerEmail);
      }
    });
  }, [proxyStatus, uploadProvider]);

  // Filter accounts list locally by search query and tabs
  const filteredAccounts = useMemo(() => {
    let result = accounts;
    if (statusFilter === "enabled") {
      result = result.filter((acc) => acc.enabled !== false);
    } else if (statusFilter === "uploaded") {
      result = result.filter((acc) => isUploaded(acc.email));
    } else if (statusFilter === "not_uploaded") {
      result = result.filter((acc) => acc.enabled && acc.hasToken && !isUploaded(acc.email));
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(
        (acc) =>
          (acc.email || "").toLowerCase().includes(q) ||
          (acc.alias && acc.alias.toLowerCase().includes(q)) ||
          (acc.projectId && acc.projectId.toLowerCase().includes(q))
      );
    }

    // Client-side sorting: sort by id ascending
    return [...result].sort((a, b) => a.id - b.id);
  }, [accounts, statusFilter, searchQuery, isUploaded]);

  // Pagination calculations
  const paginatedAccounts = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredAccounts.slice(start, start + pageSize);
  }, [filteredAccounts, page, pageSize]);

  const totalAccounts = filteredAccounts.length;
  const totalPages = Math.max(1, Math.ceil(totalAccounts / pageSize));

  // Selection handlers
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const uploadableIds = filteredAccounts
        .filter((acc) => acc.hasToken)
        .map((acc) => acc.id);
      setSelectedIds(new Set(uploadableIds));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleSelectOne = (id: number, checked: boolean) => {
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
    const body: { ids: number[]; clientId?: string; clientSecret?: string; provider: string } = {
      ids: Array.from(selectedIds),
      provider: uploadProvider,
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
      }>("rosetta/upload-cliproxy", {
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

  const getStatusBadge = (acc: RosettaAccount) => {
    if (!acc.enabled) {
      return <Badge variant="secondary">已停用</Badge>;
    }
    
    const geminiUp = isUploaded(acc.email, "gemini");
    const antiUp = isUploaded(acc.email, "antigravity");

    return (
      <div className="flex flex-col sm:flex-row gap-1.5">
        <Badge className={`text-[10px] border-none font-normal shrink-0 ${geminiUp ? "bg-emerald-600 hover:bg-emerald-700 text-white" : "bg-muted text-muted-foreground"}`}>
          Gemini: {geminiUp ? "已上号" : "未上号"}
        </Badge>
        <Badge className={`text-[10px] border-none font-normal shrink-0 ${antiUp ? "bg-emerald-600 hover:bg-emerald-700 text-white" : "bg-muted text-muted-foreground"}`}>
          Antigravity: {antiUp ? "已上号" : "未上号"}
        </Badge>
      </div>
    );
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
                          <span className="truncate">
                            {typeof file === "string" ? file : (file.name || file.email || "Unknown File")}
                          </span>
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
            <div className="flex flex-col gap-4 rounded-lg border border-border bg-muted/20 p-4">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-semibold text-foreground">目标上号通道 (Target Provider)</label>
                <Select
                  value={uploadProvider}
                  onValueChange={(value) => {
                    setUploadProvider(value as "gemini" | "antigravity");
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="w-full bg-background font-medium">
                    <SelectValue placeholder="选择目标通道" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gemini">Gemini CLI OAuth (gemini-cli)</SelectItem>
                    <SelectItem value="antigravity">Antigravity OAuth (antigravity)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-sm font-semibold text-foreground">选择凭证预设</label>
                <Select
                  value={presetType}
                  onValueChange={(value) => setPresetType(value as "google_sdk" | "wails_client" | "custom")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择凭证类型" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="google_sdk">谷歌 SDK 官方客户端凭证 (内置默认)</SelectItem>
                    <SelectItem value="wails_client">BingchaAI Wails 客户端凭证 (推荐)</SelectItem>
                    <SelectItem value="custom">自定义凭证输入</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-3 pt-3 border-t border-border mt-1">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-muted-foreground">Client ID</label>
                    {presetType !== "custom" && (
                      <span className="text-[10px] text-indigo-500 font-medium bg-indigo-50 dark:bg-indigo-950/30 px-1.5 py-0.5 rounded">
                        只读预设
                      </span>
                    )}
                  </div>
                  <Input
                    placeholder="谷歌 OAuth Client ID"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    disabled={presetType !== "custom"}
                    className="font-mono text-xs disabled:opacity-85 disabled:bg-muted/50 disabled:text-muted-foreground"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-muted-foreground">Client Secret</label>
                    {presetType !== "custom" && (
                      <span className="text-[10px] text-indigo-500 font-medium bg-indigo-50 dark:bg-indigo-950/30 px-1.5 py-0.5 rounded">
                        只读预设
                      </span>
                    )}
                  </div>
                  <Input
                    type="password"
                    placeholder="谷歌 OAuth Client Secret"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    disabled={presetType !== "custom"}
                    className="font-mono text-xs disabled:opacity-85 disabled:bg-muted/50 disabled:text-muted-foreground"
                  />
                </div>
              </div>

              {presetType === "google_sdk" && (
                <div className="text-xs text-muted-foreground bg-emerald-50/30 dark:bg-emerald-950/10 p-3 rounded-md border border-emerald-500/20 flex items-start gap-2 leading-relaxed mt-1">
                  <ShieldCheckIcon className="size-4 text-emerald-500 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold text-foreground">模式：谷歌 Cloud SDK 官方凭证</span>
                    <p className="mt-1 text-[11px]">
                      将使用内置的官方 Google SDK Client ID 进行项目名探测。适用于直接通过官方 Google Cloud CLI 流程获取 token 的子号。
                    </p>
                  </div>
                </div>
              )}

              {presetType === "wails_client" && (
                <div className="text-xs text-muted-foreground bg-indigo-50/30 dark:bg-indigo-950/10 p-3 rounded-md border border-indigo-500/20 flex items-start gap-2 leading-relaxed mt-1">
                  <ShieldCheckIcon className="size-4 text-indigo-500 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold text-foreground">模式：BingchaAI Wails 客户端凭证</span>
                    <p className="mt-1 text-[11px]">
                      已自动填充 BingchaAI 专用的 Client ID 与 Secret。如果您的大部分子号是通过 BingchaAI Wails 客户端等自定义客户端抓取的 Refresh Token，请务必选用此项，以避免 Google OAuth 400 (unauthorized_client) 报错。
                    </p>
                  </div>
                </div>
              )}

              {presetType === "custom" && (
                <div className="text-[11px] text-amber-600 dark:text-amber-500 bg-amber-50 dark:bg-amber-950/20 p-2.5 rounded border border-amber-200 dark:border-amber-900/50 flex items-start gap-1.5 mt-1 leading-normal">
                  <ShieldAlertIcon className="size-4 shrink-0 text-amber-500 mt-0.5" />
                  <span>
                    提示：项目 ID 探测接口（discoverProjectId）会使用您填写的自定义 Client ID 与 Secret 换取 Access Token。请确保该子号的 Refresh Token 确实是由对应的 Client ID 申请而来的。
                  </span>
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
              placeholder="搜索账号邮箱/别名/Project..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1);
              }}
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
              { id: "enabled", label: "已启用" },
              { id: "uploaded", label: "已上号" },
              { id: "not_uploaded", label: "未上号" },
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
                          paginatedAccounts.length > 0 &&
                          paginatedAccounts
                            .filter((a) => a.hasToken)
                            .every((a) => selectedIds.has(a.id))
                        }
                        onChange={(e) => handleSelectAll(e.target.checked)}
                      />
                    </TableHead>
                    <TableHead>子号邮箱</TableHead>
                    <TableHead>别名</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>凭证状态</TableHead>
                    <TableHead>Project ID</TableHead>
                    <TableHead>套餐</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedAccounts.map((acc) => {
                    const isSelectable = acc.hasToken;
                    return (
                      <TableRow
                        key={acc.id}
                        className={`hover:bg-muted/40 ${
                          !acc.enabled ? "opacity-60 bg-muted/20" : ""
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
                          <span>{acc.email}</span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {acc.alias || "-"}
                        </TableCell>
                        <TableCell>{getStatusBadge(acc)}</TableCell>
                        <TableCell>
                          {acc.hasToken ? (
                            <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium bg-emerald-50 dark:bg-emerald-950/20 px-2 py-0.5 rounded border border-emerald-100 dark:border-emerald-900/30">
                              含有 Refresh Token
                            </span>
                          ) : (
                            <span className="text-xs text-amber-600 dark:text-amber-500 font-medium bg-amber-50 dark:bg-amber-950/20 px-2 py-0.5 rounded border border-amber-100 dark:border-amber-900/30">
                              无 Token (不可上传)
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs font-mono text-muted-foreground">
                          {acc.projectId || "-"}
                        </TableCell>
                        <TableCell className="text-xs font-mono text-muted-foreground">
                          {acc.planType || "-"}
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
