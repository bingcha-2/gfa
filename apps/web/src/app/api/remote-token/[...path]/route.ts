import { NextRequest, NextResponse } from "next/server";

const REMOTE_TOKEN_BASE_URL =
  process.env.REMOTE_TOKEN_SERVER_URL || "http://127.0.0.1:60700";

const ALLOWED_PATHS = new Set([
  "status",
  "health",
  "lease-token",
  "report-result",
  "reload-accounts",
]);

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function forward(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  const targetPath = path?.join("/") || "";

  if (!ALLOWED_PATHS.has(targetPath)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const upstream = new URL(targetPath, `${REMOTE_TOKEN_BASE_URL.replace(/\/+$/, "")}/`);
  request.nextUrl.searchParams.forEach((value, key) => {
    upstream.searchParams.append(key, value);
  });

  const headers = new Headers();
  for (const name of ["authorization", "x-token-server-secret", "content-type"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("accept", "application/json");

  const init: RequestInit = {
    method: request.method,
    headers,
    cache: "no-store",
  };

  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = await request.text();
  }

  try {
    const response = await fetch(upstream, init);
    const body = await response.text();
    const nextResponse = new NextResponse(body, { status: response.status });
    const contentType = response.headers.get("content-type");
    if (contentType) nextResponse.headers.set("content-type", contentType);
    return nextResponse;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Remote Token Server unavailable" },
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
