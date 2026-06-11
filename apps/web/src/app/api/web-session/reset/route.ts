import { NextRequest, NextResponse } from "next/server";

const BACKEND_BASE_URL =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:3001/api";

export async function POST(request: NextRequest) {
  const payload = await request.json();

  const response = await fetch(`${BACKEND_BASE_URL}/web/auth/reset-password`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  const raw = await response.text();
  const data = raw ? JSON.parse(raw) : null;

  if (!response.ok) {
    return NextResponse.json(data ?? { message: "Reset failed" }, {
      status: response.status,
    });
  }

  return NextResponse.json({ ok: true });
}
