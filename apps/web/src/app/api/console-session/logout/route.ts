import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { CONSOLE_AUTH_COOKIE, getConsoleCookieDomain } from "@/lib/console/auth-cookie";

export async function POST() {
  const cookieStore = await cookies();
  // A Domain-scoped cookie (split-domain deploys) is a different cookie
  // identity than a host-only one — the delete must carry the same Domain.
  const cookieDomain = getConsoleCookieDomain();
  if (cookieDomain) {
    cookieStore.delete({ name: CONSOLE_AUTH_COOKIE, path: "/", domain: cookieDomain });
  } else {
    cookieStore.delete(CONSOLE_AUTH_COOKIE);
  }

  return NextResponse.json({ ok: true });
}
