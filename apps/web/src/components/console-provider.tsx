"use client";

import { createContext, useContext, useCallback, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { apiRequest, getErrorMessage } from "@/lib/client-api";
import type { SessionUser } from "@/lib/types";

type ConsoleContextValue = {
  user: SessionUser;
  stats: any;
  refreshStats: () => Promise<void>;
  runAction: (action: () => Promise<unknown>) => Promise<boolean>;
  handleLogout: () => Promise<void>;
  isRefreshing: boolean;
};

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function useConsole() {
  const ctx = useContext(ConsoleContext);
  if (!ctx) throw new Error("useConsole must be used within ConsoleProvider");
  return ctx;
}

function getPrefix() {
  return (
    (process.env.NEXT_PUBLIC_ADMIN_PATH_PREFIX ?? "console").replace(
      /^\/|\/$/g,
      ""
    ) || "console"
  );
}

function isUnauthorized(message: string) {
  const n = message.toLowerCase();
  return n.includes("unauthorized") || n.includes("jwt") || n.includes("401");
}

export function ConsoleProvider({
  initialUser,
  initialStats,
  children,
}: {
  initialUser: SessionUser;
  initialStats: any;
  children: ReactNode;
}) {
  const router = useRouter();
  const [user] = useState(initialUser);
  const [stats, setStats] = useState<any>(initialStats);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refreshStats = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const newStats = await apiRequest<any>("stats");
      setStats(newStats);
    } catch (err) {
      const msg = getErrorMessage(err);
      if (isUnauthorized(msg)) {
        router.push(`/${getPrefix()}/login`);
        router.refresh();
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [router]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
        await refreshStats();
        return true;
      } catch (err) {
        const msg = getErrorMessage(err);
        if (isUnauthorized(msg)) {
          router.push(`/${getPrefix()}/login`);
          router.refresh();
          return false;
        }
        toast.error(msg);
        return false;
      }
    },
    [router, refreshStats]
  );

  const handleLogout = useCallback(async () => {
    await fetch("/api/session/logout", {
      method: "POST",
      cache: "no-store",
    });
    router.push(`/${getPrefix()}/login`);
    router.refresh();
  }, [router]);

  return (
    <ConsoleContext.Provider
      value={{ user, stats, refreshStats, runAction, handleLogout, isRefreshing }}
    >
      {children}
    </ConsoleContext.Provider>
  );
}
