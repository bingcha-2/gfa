import { NextRequest, NextResponse } from "next/server";

import { CONSOLE_AUTH_COOKIE } from "../../../../lib/auth-cookie";

const BACKEND_BASE_URL =
  process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";

/**
 * Path whitelist — only these API path prefixes are allowed through the proxy.
 * This prevents abuse if an XSS vulnerability is exploited on the frontend.
 * Add new prefixes here as the frontend adds new API integrations.
 */
const ALLOWED_PATH_PREFIXES = [
  "auth",
  "stats",
  "family-groups",
  "orders",
  "tasks",
  "accounts",
  "redeem-codes",
  "scheduler",
  "queue",
  "expire-scan",
  "audit-logs",
  "public",
];

function isPathAllowed(pathSegments: string[]): boolean {
  const fullPath = pathSegments.join("/");
  return ALLOWED_PATH_PREFIXES.some(
    (prefix) => fullPath === prefix || fullPath.startsWith(prefix + "/") || fullPath.startsWith(prefix + "?")
  );
}

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

export const dynamic = "force-dynamic";

async function forward(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;

  if (!path?.length) {
    return NextResponse.json({ message: "Missing target path" }, { status: 400 });
  }

  // Security: reject paths not in the whitelist
  if (!isPathAllowed(path)) {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }

  const upstream = new URL(`${BACKEND_BASE_URL}/${path.join("/")}`);

  request.nextUrl.searchParams.forEach((value, key) => {
    upstream.searchParams.append(key, value);
  });

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  const authorization = request.headers.get("authorization");
  const cookieToken = request.cookies.get(CONSOLE_AUTH_COOKIE)?.value;

  if (contentType) {
    headers.set("content-type", contentType);
  }

  if (authorization) {
    headers.set("authorization", authorization);
  } else if (cookieToken) {
    headers.set("authorization", `Bearer ${cookieToken}`);
  }

  headers.set("accept", "application/json");

  const init: RequestInit = {
    method: request.method,
    headers,
    cache: "no-store"
  };

  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = await request.text();
  }

  try {
    const response = await fetch(upstream, init);
    const payload = await response.text();
    const nextResponse = new NextResponse(payload, {
      status: response.status
    });

    const upstreamType = response.headers.get("content-type");

    if (upstreamType) {
      nextResponse.headers.set("content-type", upstreamType);
    }

    return nextResponse;
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "Failed to reach backend API"
      },
      { status: 502 }
    );
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  return forward(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return forward(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return forward(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return forward(request, context);
}
