/**
 * Tests for the notifications optimistic mark-read flow:
 *   src/components/account/notifications-list.tsx
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { NotificationsList } from "@/components/account/notifications-list";

// The list shares the topnav bell count via useAccount().
const { setUnread, refreshUnread } = vi.hoisted(() => ({
  setUnread: vi.fn(),
  refreshUnread: vi.fn(),
}));
vi.mock("@/components/account/account-provider", () => ({
  useAccount: () => ({ setUnread, refreshUnread }),
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PAGE = {
  notifications: [
    {
      id: "n1",
      type: "SYSTEM",
      title: "维护公告",
      body: "今晚维护",
      readAt: null,
      createdAt: "2026-06-10T00:00:00.000Z",
    },
    {
      id: "n2",
      type: "BILLING",
      title: "订单已支付",
      body: "感谢购买",
      readAt: "2026-06-09T00:00:00.000Z",
      createdAt: "2026-06-09T00:00:00.000Z",
    },
  ],
  total: 2,
  unread: 1,
};

function mockNotificationsFetch(postStatus = 200) {
  return vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve(
        postStatus === 200
          ? jsonResponse({ ok: true })
          : jsonResponse({ message: "boom" }, postStatus)
      );
    }
    return Promise.resolve(jsonResponse(PAGE));
  });
}

describe("NotificationsList", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    setUnread.mockClear();
    refreshUnread.mockClear();
  });

  it("renders items with unread state and marks one read optimistically", async () => {
    const mockFetch = mockNotificationsFetch();
    vi.stubGlobal("fetch", mockFetch);

    render(<NotificationsList />);

    await waitFor(() => {
      expect(screen.getByText("维护公告")).toBeInTheDocument();
    });

    // Bell synced to the server's unread count when the list loads.
    expect(setUnread).toHaveBeenCalledWith(1);

    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveAttribute("data-read", "false");
    expect(items[1]).toHaveAttribute("data-read", "true");

    // Click 标记已读 — item dims IMMEDIATELY (optimistic), then POST goes out
    fireEvent.click(screen.getByRole("button", { name: "标记已读" }));
    expect(screen.getAllByRole("listitem")[0]).toHaveAttribute(
      "data-read",
      "true"
    );

    await waitFor(() => {
      const posts = mockFetch.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST"
      );
      expect(posts).toHaveLength(1);
      expect(String(posts[0][0])).toContain(
        "/api/account/notifications/n1/read"
      );
    });
  });

  it("rolls back the optimistic read when the POST fails", async () => {
    const mockFetch = mockNotificationsFetch(500);
    vi.stubGlobal("fetch", mockFetch);

    render(<NotificationsList />);

    await waitFor(() => {
      expect(screen.getByText("维护公告")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "标记已读" }));
    // optimistic flip…
    expect(screen.getAllByRole("listitem")[0]).toHaveAttribute(
      "data-read",
      "true"
    );

    // …then rollback after the failure
    await waitFor(() => {
      expect(screen.getAllByRole("listitem")[0]).toHaveAttribute(
        "data-read",
        "false"
      );
    });
  });

  it("marks everything read via 全部已读", async () => {
    const mockFetch = mockNotificationsFetch();
    vi.stubGlobal("fetch", mockFetch);

    render(<NotificationsList />);

    await waitFor(() => {
      expect(screen.getByText("维护公告")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "全部已读" }));

    // All items optimistically read
    for (const item of screen.getAllByRole("listitem")) {
      expect(item).toHaveAttribute("data-read", "true");
    }

    await waitFor(() => {
      const posts = mockFetch.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST"
      );
      expect(posts).toHaveLength(1);
      expect(String(posts[0][0])).toContain(
        "/api/account/notifications/read-all"
      );
    });

    // Bell cleared to zero alongside the optimistic mark-all.
    expect(setUnread).toHaveBeenCalledWith(0);
  });

  it("rolls back the optimistic mark-all when read-all fails", async () => {
    const mockFetch = mockNotificationsFetch(500);
    vi.stubGlobal("fetch", mockFetch);

    render(<NotificationsList />);

    await waitFor(() => {
      expect(screen.getByText("维护公告")).toBeInTheDocument();
    });

    // Pre-condition: first item is unread.
    expect(screen.getAllByRole("listitem")[0]).toHaveAttribute(
      "data-read",
      "false"
    );

    fireEvent.click(screen.getByRole("button", { name: "全部已读" }));

    // Optimistic: everything flips to read…
    for (const item of screen.getAllByRole("listitem")) {
      expect(item).toHaveAttribute("data-read", "true");
    }

    // …then the snapshot is restored after the failure (n1 unread again).
    await waitFor(() => {
      expect(screen.getAllByRole("listitem")[0]).toHaveAttribute(
        "data-read",
        "false"
      );
    });
    // n2 was already read and stays read.
    expect(screen.getAllByRole("listitem")[1]).toHaveAttribute(
      "data-read",
      "true"
    );
  });
});
