"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ArrowRightLeftIcon,
  CheckCheckIcon,
  CreditCardIcon,
  GiftIcon,
  InfoIcon,
  MessageSquareIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { DataPagination } from "@/components/account/data-pagination";
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/account/user-api";
import type {
  NotificationType,
  NotificationsPage,
} from "@/lib/account/user-types";
import { formatDateTime } from "@/lib/format";
import { useDict } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;

const TYPE_ICONS: Record<NotificationType, React.ReactNode> = {
  SYSTEM: <InfoIcon className="size-4" />,
  BILLING: <CreditCardIcon className="size-4" />,
  TICKET: <MessageSquareIcon className="size-4" />,
  REFERRAL: <GiftIcon className="size-4" />,
  MIGRATION: <ArrowRightLeftIcon className="size-4" />,
};

export function NotificationsList() {
  const dict = useDict();
  const n = dict.portalApp.notifications;

  const [data, setData] = useState<NotificationsPage | null>(null);
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async (p: number) => {
    try {
      const next = await getNotifications(p, PAGE_SIZE);
      setData(next);
      setLoadError(false);
    } catch {
      setData({ notifications: [], total: 0, unread: 0 });
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load(page);
  }, [page, load]);

  function applyRead(id: string, readAt: string | null) {
    setData((prev) => {
      if (!prev) return prev;
      let unreadDelta = 0;
      const notifications = prev.notifications.map((item) => {
        if (item.id !== id) return item;
        if (!item.readAt && readAt) unreadDelta = -1;
        if (item.readAt && !readAt) unreadDelta = 1;
        return { ...item, readAt };
      });
      return {
        ...prev,
        notifications,
        unread: Math.max(0, prev.unread + unreadDelta),
      };
    });
  }

  async function handleMarkRead(id: string) {
    // Optimistic — flip immediately, roll back on failure.
    applyRead(id, new Date().toISOString());
    try {
      await markNotificationRead(id);
    } catch {
      applyRead(id, null);
      toast.error(n.markFailed);
    }
  }

  async function handleMarkAll() {
    const snapshot = data;
    setData((prev) =>
      prev
        ? {
            ...prev,
            unread: 0,
            notifications: prev.notifications.map((item) => ({
              ...item,
              readAt: item.readAt ?? new Date().toISOString(),
            })),
          }
        : prev
    );
    try {
      await markAllNotificationsRead();
    } catch {
      setData(snapshot);
      toast.error(n.markFailed);
    }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const hasUnread = (data?.unread ?? 0) > 0;

  if (data === null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-16 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {loadError && (
        <p className="text-sm text-destructive">{n.loadFailed}</p>
      )}

      {data.notifications.length > 0 && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={handleMarkAll}
            disabled={!hasUnread}
          >
            <CheckCheckIcon data-icon="inline-start" />
            {n.markAllRead}
          </Button>
        </div>
      )}

      {data.notifications.length === 0 ? (
        <Empty className="border min-h-[280px]">
          <EmptyHeader>
            <EmptyTitle>{n.empty}</EmptyTitle>
            <EmptyDescription>{n.emptyDesc}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="space-y-2">
          {data.notifications.map((item) => {
            const read = !!item.readAt;
            return (
              <li
                key={item.id}
                data-read={read}
                className={cn(
                  "rounded-xl border bg-card p-4 flex items-start gap-3 transition-opacity duration-200",
                  read && "opacity-60"
                )}
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  {TYPE_ICONS[item.type]}
                </span>

                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    {!read && (
                      <span
                        aria-hidden
                        className="size-1.5 shrink-0 rounded-full bg-accent"
                      />
                    )}
                    <span className="truncate text-sm font-medium">
                      {item.title}
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatDateTime(item.createdAt)}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground whitespace-pre-line">
                    {item.body}
                  </p>
                  <div className="flex items-center gap-2 pt-0.5">
                    <span className="text-[11px] text-muted-foreground">
                      {n.types[item.type]}
                    </span>
                    {!read && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs ml-auto"
                        onClick={() => void handleMarkRead(item.id)}
                      >
                        {n.markRead}
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <DataPagination
        page={page}
        totalPages={totalPages}
        onPage={setPage}
        labels={{
          prevPage: n.prevPage,
          nextPage: n.nextPage,
          pageInfo: n.pageInfo,
        }}
      />
    </div>
  );
}
