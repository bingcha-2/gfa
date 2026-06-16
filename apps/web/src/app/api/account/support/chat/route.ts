/**
 * 客服对话的「流式」代理 —— 专门覆盖通用 /api/account/[...path] 代理。
 *
 * 通用代理用 `await res.text()` 把响应整体缓冲,会破坏 SSE 流式;这里直接把
 * 后端的 SSE 响应体(ReadableStream)透传给浏览器,逐帧到达。
 *
 * 仅转发到后端 /account/support/chat,鉴权沿用 httpOnly cookie → Bearer。
 */
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { USER_AUTH_COOKIE } from "@/lib/account/user-auth-cookie";
import { getBackendBaseUrl } from "@/lib/backend-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const token = (await cookies()).get(USER_AUTH_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const body = await request.text();

  let backendResponse: Response;
  try {
    backendResponse = await fetch(`${getBackendBaseUrl()}/account/support/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body,
      cache: "no-store",
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "SERVICE_UNAVAILABLE",
        message: err instanceof Error ? err.message : "Backend unreachable",
      },
      { status: 502 },
    );
  }

  // 非 2xx(如 401/429):后端多半返回 JSON,原样透传,前端按错误处理。
  return new Response(backendResponse.body, {
    status: backendResponse.status,
    headers: {
      "content-type":
        backendResponse.headers.get("content-type") ??
        "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
