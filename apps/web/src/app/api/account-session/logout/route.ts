import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { USER_AUTH_COOKIE, getUserCookieDomain } from "@/lib/account/user-auth-cookie";

export async function POST() {
  // Intentionally no backend call: customer JWTs are stateless and no backend /account/auth/logout endpoint exists — clearing the cookie fully ends the session.
  const cookieStore = await cookies();
  // A Domain-scoped cookie (split-domain deploys) is a different cookie
  // identity than a host-only one — the delete must carry the same Domain.
  const cookieDomain = getUserCookieDomain();
  if (cookieDomain) {
    cookieStore.delete({ name: USER_AUTH_COOKIE, path: "/", domain: cookieDomain });
  } else {
    cookieStore.delete(USER_AUTH_COOKIE);
  }

  return NextResponse.json({ ok: true });
}
