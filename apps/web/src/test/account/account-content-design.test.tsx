import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { NotificationsList } from "@/components/account/notifications-list";
import { TicketsList } from "@/components/account/tickets-list";

const root = path.resolve(__dirname, "../..");

// NotificationsList shares the topnav bell count via useAccount(). The fns
// must be STABLE refs (like React's real useState setter) — a fresh vi.fn()
// per render would change load()'s deps and spin the load effect.
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

describe("account content design contracts", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("workflow pages use the redesigned account panel primitives", async () => {
    const css = fs.readFileSync(path.join(root, "components/account/account.css"), "utf8");

    expect(css).toContain(".account-workflow-grid");
    expect(css).toContain(".account-summary-strip");
    expect(css).toContain(".account-support-panel");
  });

  it("notifications render as an account message center without shadcn buttons or empty slots", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          notifications: [
            {
              id: "n1",
              type: "SYSTEM",
              title: "维护公告",
              body: "今晚维护",
              readAt: null,
              createdAt: "2026-06-10T00:00:00.000Z",
            },
          ],
          total: 1,
          unread: 1,
        })
      )
    );

    const { container } = render(<NotificationsList />);

    await waitFor(() => {
      expect(screen.getByText("维护公告")).toBeInTheDocument();
    });

    expect(container.querySelector(".account-notifications")).toBeInTheDocument();
    expect(container.querySelector(".account-message-list")).toBeInTheDocument();
    expect(container.querySelector("[data-slot='button']")).not.toBeInTheDocument();
    expect(container.querySelector("[data-slot='empty']")).not.toBeInTheDocument();
  });

  it("tickets list renders account support center and custom dialog surface", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          tickets: [
            {
              id: "t1",
              subject: "无法登录",
              status: "OPEN",
              createdAt: "2026-06-09T00:00:00.000Z",
              updatedAt: "2026-06-09T01:00:00.000Z",
            },
          ],
        })
      )
    );

    const { container } = render(<TicketsList />);

    await waitFor(() => {
      expect(screen.getByText("无法登录")).toBeInTheDocument();
    });

    expect(container.querySelector(".account-ticket-center")).toBeInTheDocument();
    expect(container.querySelector(".account-data-table")).toBeInTheDocument();
    expect(container.querySelector("[data-slot='table']")).not.toBeInTheDocument();
    expect(container.querySelector("[data-slot='button']")).not.toBeInTheDocument();
    expect(container.querySelector("[data-slot='dialog-content']")).not.toBeInTheDocument();
  });
});
