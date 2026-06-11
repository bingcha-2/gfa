/**
 * Tests for the ticket thread + reply flow (incl. 409 TICKET_CLOSED):
 *   src/components/account/ticket-thread.tsx
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { TicketThread } from "@/components/account/ticket-thread";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const OPEN_THREAD = {
  ticket: {
    id: "t1",
    subject: "无法登录",
    status: "ANSWERED",
    createdAt: "2026-06-09T00:00:00.000Z",
  },
  messages: [
    {
      id: "m1",
      authorType: "CUSTOMER",
      body: "客户端登录报错",
      createdAt: "2026-06-09T00:00:00.000Z",
    },
    {
      id: "m2",
      authorType: "ADMIN",
      body: "请提供报错截图",
      createdAt: "2026-06-09T01:00:00.000Z",
    },
  ],
};

describe("TicketThread", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the thread and sends a reply", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return Promise.resolve(
            jsonResponse(
              {
                message: {
                  id: "m3",
                  authorType: "CUSTOMER",
                  body: "截图已上传",
                  createdAt: "2026-06-09T02:00:00.000Z",
                },
              },
              201
            )
          );
        }
        return Promise.resolve(jsonResponse(OPEN_THREAD));
      });
    vi.stubGlobal("fetch", mockFetch);

    render(<TicketThread ticketId="t1" />);

    await waitFor(() => {
      expect(screen.getByText("客户端登录报错")).toBeInTheDocument();
      expect(screen.getByText("请提供报错截图")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText("输入回复内容…"), {
      target: { value: "截图已上传" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送回复" }));

    await waitFor(() => {
      expect(screen.getByText("截图已上传")).toBeInTheDocument();
    });

    const posts = mockFetch.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST"
    );
    expect(posts).toHaveLength(1);
    expect(String(posts[0][0])).toContain("/api/web/tickets/t1/messages");
    expect(JSON.parse((posts[0][1] as RequestInit).body as string)).toEqual({
      body: "截图已上传",
    });
  });

  it("handles 409 TICKET_CLOSED — shows closed notice and disables composer", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return Promise.resolve(
            jsonResponse({ error: "TICKET_CLOSED", message: "closed" }, 409)
          );
        }
        return Promise.resolve(jsonResponse(OPEN_THREAD));
      });
    vi.stubGlobal("fetch", mockFetch);

    render(<TicketThread ticketId="t1" />);

    await waitFor(() => {
      expect(screen.getByText("客户端登录报错")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText("输入回复内容…"), {
      target: { value: "还在吗" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送回复" }));

    await waitFor(() => {
      expect(
        screen.getByText("工单已关闭,无法继续回复。")
      ).toBeInTheDocument();
    });
    // Composer gone after the ticket flips to closed
    expect(
      screen.queryByPlaceholderText("输入回复内容…")
    ).not.toBeInTheDocument();
  });

  it("renders a CLOSED ticket without a composer", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ticket: { ...OPEN_THREAD.ticket, status: "CLOSED" },
        messages: OPEN_THREAD.messages,
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    render(<TicketThread ticketId="t1" />);

    await waitFor(() => {
      expect(
        screen.getByText("工单已关闭,无法继续回复。")
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByPlaceholderText("输入回复内容…")
    ).not.toBeInTheDocument();
  });

  it("shows the not-found state on a 404", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: "TICKET_NOT_FOUND" }, 404)
      );
    vi.stubGlobal("fetch", mockFetch);

    render(<TicketThread ticketId="missing" />);

    await waitFor(() => {
      expect(screen.getByText("工单不存在或已被删除。")).toBeInTheDocument();
    });
    // Not the generic error state.
    expect(
      screen.queryByText("工单加载失败,请重试。")
    ).not.toBeInTheDocument();
  });

  it("shows a retryable error state on a 500 (not 'not found')", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      call += 1;
      // First load fails with 500; retry succeeds.
      if (call === 1) {
        return Promise.resolve(jsonResponse({ message: "boom" }, 500));
      }
      return Promise.resolve(jsonResponse(OPEN_THREAD));
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<TicketThread ticketId="t1" />);

    await waitFor(() => {
      expect(screen.getByText("工单加载失败,请重试。")).toBeInTheDocument();
    });
    // Must NOT be the not-found copy.
    expect(
      screen.queryByText("工单不存在或已被删除。")
    ).not.toBeInTheDocument();

    // Retry recovers the thread.
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => {
      expect(screen.getByText("客户端登录报错")).toBeInTheDocument();
    });
  });
});
