"use client";

import { useConsole } from "@/components/console/shell/console-provider";
import { AgentServicePanel } from "@/components/console/google-family/agent-service-panel";
import { toast } from "sonner";

export default function AgentServicePage() {
  const { user } = useConsole();
  const isSuperAdmin = user.role === "SUPER_ADMIN";
  const isAdminOrOps = isSuperAdmin || user.role === "ADMIN" || user.role === "OPERATIONS";
  const userPerms: string[] | null = (user as any).permissions ?? null;
  const hasPermission = isSuperAdmin || !userPerms || userPerms.length === 0 || userPerms.includes("agent_service");
  const canManage = isAdminOrOps && hasPermission;

  if (!canManage) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">无权访问代理服务模块</p>
      </div>
    );
  }

  return (
    <AgentServicePanel
      showToast={(type, msg) => {
        if (type === "success") toast.success(msg);
        else if (type === "error") toast.error(msg);
        else toast.info(msg);
      }}
    />
  );
}
