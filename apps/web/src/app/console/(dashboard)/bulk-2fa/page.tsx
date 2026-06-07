"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { 
  Key, 
  Play, 
  Download, 
  AlertTriangle, 
  CheckCircle, 
  RefreshCw, 
  Upload, 
  FileText, 
  Clock, 
  XCircle,
  HelpCircle,
  Eye,
  EyeOff
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface BulkJobItem {
  id: string;
  rawLine: string;
  email: string;
  password: string;
  oldSecret?: string;
  recoveryEmail?: string;
  status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
  newSecret?: string;
  error?: string;
  updatedAt: string;
}

interface BulkJob {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  createdAt: string;
  updatedAt: string;
  items: BulkJobItem[];
}

interface JobSummary {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  totalItems: number;
  successCount: number;
  failedCount: number;
}

export default function Bulk2faPage() {
  const [inputText, setInputText] = useState("");
  const [activeJob, setActiveJob] = useState<BulkJob | null>(null);
  const [jobsHistory, setJobsHistory] = useState<JobSummary[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch recent jobs history
  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/bulk-2fa/jobs");
      if (!res.ok) throw new Error("Failed to fetch history");
      const data = await res.json();
      setJobsHistory(data);
    } catch (err: any) {
      console.error(err);
      toast.error("加载历史任务失败");
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  // Fetch active job status
  const fetchJobStatus = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/bulk-2fa/jobs/${jobId}`);
      if (!res.ok) throw new Error("Failed to fetch job details");
      const job: BulkJob = await res.json();
      setActiveJob(job);
      
      // If job is finished, stop polling and refresh history
      if (job.status === "COMPLETED" || job.status === "FAILED") {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        toast.success(`任务 ${jobId} 执行完毕`);
        fetchHistory();
      }
    } catch (err: any) {
      console.error(err);
      toast.error("获取任务状态失败");
    }
  }, [fetchHistory]);

  // Start polling
  const startPolling = useCallback((jobId: string) => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
    }
    // Poll every 3 seconds
    pollTimerRef.current = setInterval(() => {
      fetchJobStatus(jobId);
    }, 3000);
  }, [fetchJobStatus]);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Handle text submission
  const handleSubmit = async () => {
    if (!inputText.trim()) {
      toast.error("请输入账号凭证");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/bulk-2fa/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: inputText }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.message || `HTTP ${res.status}`);
      }
      const data: BulkJob = await res.json();
      setActiveJob(data);
      setInputText("");
      toast.success(`任务已创建，ID: ${data.id}`);
      startPolling(data.id);
    } catch (err: any) {
      toast.error("创建任务失败: " + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // Handle file upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setInputText(text);
      toast.success(`成功导入文件 "${file.name}"`);
    };
    reader.onerror = () => {
      toast.error("读取文件失败");
    };
    reader.readAsText(file);
  };

  // Select a past job to view
  const handleViewJob = async (jobId: string) => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    try {
      const res = await fetch(`/api/bulk-2fa/jobs/${jobId}`);
      if (!res.ok) throw new Error("Failed to fetch job details");
      const job: BulkJob = await res.json();
      setActiveJob(job);
      if (job.status === "PENDING" || job.status === "PROCESSING") {
        startPolling(job.id);
      }
    } catch (err: any) {
      toast.error("加载任务详情失败");
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "SUCCESS":
        return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300">成功</span>;
      case "FAILED":
        return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300">失败</span>;
      case "RUNNING":
        return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300 animate-pulse">执行中</span>;
      case "PENDING":
      default:
        return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300">等待中</span>;
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto p-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Key className="h-6 w-6 text-primary" />
          批量修改 2FA (免数据库独立工具)
        </h1>
        <p className="text-muted-foreground mt-1">
          录入账号凭证后，由后台 Worker 使用 AdsPower 浏览器自动登录并更改 Google 账号的 2FA 密钥。不影响系统原有主号数据。
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left pane - Input & Config */}
        <div className="lg:col-span-1 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>录入凭证</CardTitle>
              <CardDescription>
                支持粘贴或直接上传 TXT 文件。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="accounts-input" className="mb-2 block text-sm font-medium">
                  每行一个账号（格式如：邮箱----密码----[可选旧2FA]----[可选辅助邮箱]）
                </Label>
                <Textarea
                  id="accounts-input"
                  rows={8}
                  className="font-mono text-xs w-full p-2 border rounded-md"
                  placeholder="user1@gmail.com----pass123----OLDSECRET----recovery@gmail.com&#10;user2@gmail.com----pass456"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  disabled={submitting}
                />
              </div>

              <div className="flex items-center justify-between border-t pt-4">
                <div className="flex items-center gap-2">
                  <Label htmlFor="file-upload" className="cursor-pointer">
                    <div className="flex items-center gap-1.5 px-3 py-1.5 border rounded-md text-sm hover:bg-muted transition">
                      <Upload className="h-4 w-4" />
                      上传 TXT 文件
                    </div>
                    <input
                      id="file-upload"
                      type="file"
                      accept=".txt"
                      className="hidden"
                      onChange={handleFileUpload}
                      disabled={submitting}
                    />
                  </Label>
                </div>
                
                <Button 
                  onClick={handleSubmit} 
                  disabled={submitting || !inputText.trim()}
                  className="flex items-center gap-1.5"
                >
                  {submitting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  开始执行
                </Button>
              </div>

              <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 p-3 text-xs text-blue-800 dark:text-blue-300">
                <div className="flex items-start gap-2">
                  <HelpCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold">使用提示：</span>
                    <ul className="list-disc pl-4 mt-1 space-y-1">
                      <li>程序将自动分配空闲的 AdsPower 浏览器执行。</li>
                      <li>请确保 AdsPower 客户端已打开并登录。</li>
                      <li>旧 2FA 密钥选填。若 Google 提示输入密码重认证，需要填写密码。</li>
                    </ul>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* History Jobs Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">历史任务列表</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingHistory ? (
                <div className="flex justify-center p-4">
                  <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : jobsHistory.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">无历史任务记录</p>
              ) : (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {jobsHistory.map((job) => (
                    <div 
                      key={job.id} 
                      onClick={() => handleViewJob(job.id)}
                      className={`flex flex-col p-2.5 rounded-lg border text-xs cursor-pointer transition hover:bg-muted ${
                        activeJob?.id === job.id ? "border-primary bg-primary/5" : "border-border"
                      }`}
                    >
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-mono font-bold text-gray-700 dark:text-gray-300">{job.id}</span>
                        {getStatusBadge(job.status)}
                      </div>
                      <div className="flex justify-between text-muted-foreground">
                        <span>共 {job.totalItems} 个 ( 成功 {job.successCount} / 失败 {job.failedCount} )</span>
                        <span>{new Date(job.createdAt).toLocaleTimeString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right pane - Job details & Live output */}
        <div className="lg:col-span-2">
          {activeJob ? (
            <Card className="h-full flex flex-col">
              <CardHeader className="pb-3 border-b flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 font-mono">
                    任务: {activeJob.id}
                  </CardTitle>
                  <CardDescription className="mt-1">
                    创建时间: {new Date(activeJob.createdAt).toLocaleString()}
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <a href={`/api/bulk-2fa/jobs/${activeJob.id}/download?type=success`} target="_blank" rel="noreferrer">
                    <Button variant="outline" size="sm" className="text-xs flex items-center gap-1">
                      <Download className="h-3.5 w-3.5 text-green-600" />
                      下载成功包
                    </Button>
                  </a>
                  <a href={`/api/bulk-2fa/jobs/${activeJob.id}/download?type=failed`} target="_blank" rel="noreferrer">
                    <Button variant="outline" size="sm" className="text-xs flex items-center gap-1">
                      <Download className="h-3.5 w-3.5 text-red-600" />
                      下载失败包
                    </Button>
                  </a>
                </div>
              </CardHeader>
              
              <CardContent className="flex-1 p-0 overflow-auto">
                <div className="p-4 bg-muted/40 border-b flex justify-between items-center text-xs">
                  <div className="flex gap-4">
                    <span>状态: <strong>{activeJob.status}</strong></span>
                    <span>总数: <strong>{activeJob.items.length}</strong></span>
                    <span>成功: <strong className="text-green-600">{activeJob.items.filter(i => i.status === "SUCCESS").count || activeJob.items.filter(i => i.status === "SUCCESS").length}</strong></span>
                    <span>失败: <strong className="text-red-600">{activeJob.items.filter(i => i.status === "FAILED").length}</strong></span>
                  </div>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="h-7 text-xs px-2"
                    onClick={() => setShowSecrets(!showSecrets)}
                  >
                    {showSecrets ? <EyeOff className="h-3.5 w-3.5 mr-1" /> : <Eye className="h-3.5 w-3.5 mr-1" />}
                    {showSecrets ? "隐藏密钥" : "显示密钥"}
                  </Button>
                </div>

                <div className="divide-y max-h-[500px] overflow-y-auto">
                  {activeJob.items.map((item, idx) => (
                    <div key={item.id} className="p-3 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs hover:bg-muted/20">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold font-mono text-sm">{idx + 1}. {item.email}</span>
                        </div>
                        <div className="text-muted-foreground flex gap-4">
                          <span>密码: {showSecrets ? item.password : "******"}</span>
                          {item.oldSecret && (
                            <span>原2FA: {showSecrets ? item.oldSecret : "******"}</span>
                          )}
                          {item.newSecret && (
                            <span className="text-green-600 font-bold">新2FA: {showSecrets ? item.newSecret : "******"}</span>
                          )}
                        </div>
                        {item.error && (
                          <div className="text-red-500 font-mono text-[11px] mt-1 bg-red-50 dark:bg-red-950/20 p-1.5 rounded border border-red-100 dark:border-red-900/30">
                            错误原因: {item.error}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 flex items-center gap-2">
                        <span className="text-muted-foreground text-[10px]">
                          {new Date(item.updatedAt).toLocaleTimeString()}
                        </span>
                        {getStatusBadge(item.status)}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="h-full min-h-[300px] flex flex-col justify-center items-center text-muted-foreground p-6 border-dashed">
              <FileText className="h-12 w-12 mb-3 text-muted-foreground/50" />
              <p className="text-sm font-medium">暂无当前活动任务</p>
              <p className="text-xs text-center max-w-sm mt-1">
                在左侧输入需要修改 2FA 的账号密码，点击“开始执行”。或者从历史列表中选择一个查看。
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
