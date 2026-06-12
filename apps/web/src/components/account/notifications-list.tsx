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

import { AccountButton, AccountEmpty, AccountPill, AccountSkeleton } from "@/components/account/account-ui";
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

const PAGE_SIZE = 20;

const TYPE_ICONS: Record<NotificationType, React.ReactNode> = {
  SYSTEM: <InfoIcon />,
  BILLING: <CreditCardIcon />,
  TICKET: <MessageSquareIcon />,
  REFERRAL: <GiftIcon />,
  MIGRATION: <ArrowRightLeftIcon />,
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
      <div className="account-skeleton-stack">
        <AccountSkeleton className="account-skeleton--message" />
        <AccountSkeleton className="account-skeleton--message" />
        <AccountSkeleton className="account-skeleton--message" />
      </div>
    );
  }

  return (
    <div className="account-notifications" data-testid="account-notifications">
      {loadError && (
        <p className="account-form-error">{n.loadFailed}</p>
      )}

      {data.notifications.length > 0 && (
        <div className="account-list-toolbar">
          <AccountButton
            variant="secondary"
            onClick={handleMarkAll}
            disabled={!hasUnread}
          >
            <CheckCheckIcon data-icon="inline-start" />
            {n.markAllRead}
          </AccountButton>
        </div>
      )}

      {data.notifications.length === 0 ? (
        <AccountEmpty title={n.empty} description={n.emptyDesc} />
      ) : (
        <ul className="account-message-list">
          {data.notifications.map((item) => {
            const read = !!item.readAt;
            return (
              <li
                key={item.id}
                data-read={read}
                className="account-message-item"
              >
                <span className="account-message-item__icon">
                  {TYPE_ICONS[item.type]}
                </span>

                <div className="account-message-item__body">
                  <div className="account-message-item__top">
                    {!read && (
                      <span
                        aria-hidden
                        className="account-message-item__unread"
                      />
                    )}
                    <span>{item.title}</span>
                    <time dateTime={item.createdAt}>
                      {formatDateTime(item.createdAt)}
                    </time>
                  </div>
                  <p>{item.body}</p>
                  <div className="account-message-item__footer">
                    <AccountPill tone="muted">{n.types[item.type]}</AccountPill>
                    {!read && (
                      <AccountButton
                        variant="ghost"
                        className="account-btn--compact"
                        onClick={() => void handleMarkRead(item.id)}
                      >
                        {n.markRead}
                      </AccountButton>
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
