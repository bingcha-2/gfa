/**
 * Public plan-catalog proxy (spec §7.2).
 *
 * Forwards GET to the backend's public /plan-catalog endpoint. No auth — the
 * catalog (products/levels/usageTiers/pricing) is needed to render the purchase
 * page before/without a session. The generic /api/account/[...path] proxy is
 * deliberately NOT usable here: it only reaches backend /account/* and always
 * requires a cookie, whereas this endpoint is public and lives at backend root.
 */

import { NextResponse } from "next/server";

import { getBackendBaseUrl } from "@/lib/backend-url";

export async function GET() {
  let response: Response;
  let raw: string;
  try {
    response = await fetch(`${getBackendBaseUrl()}/plan-catalog`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    raw = await response.text();
  } catch (err) {
    // Backend down (ECONNREFUSED etc.) — structured 502, not a stack trace.
    return NextResponse.json(
      {
        error: "SERVICE_UNAVAILABLE",
        message: err instanceof Error ? err.message : "Backend unreachable",
      },
      { status: 502 }
    );
  }

  return new NextResponse(raw || null, {
    status: response.status,
    headers: {
      "content-type":
        response.headers.get("content-type") ?? "application/json",
    },
  });
}
