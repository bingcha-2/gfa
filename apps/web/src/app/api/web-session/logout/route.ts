import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { USER_AUTH_COOKIE } from "@/lib/account/user-auth-cookie";

export async function POST() {
  // Intentionally no backend call: customer JWTs are stateless and no backend /web/auth/logout endpoint exists — clearing the cookie fully ends the session.
  const cookieStore = await cookies();
  cookieStore.delete(USER_AUTH_COOKIE);

  return NextResponse.json({ ok: true });
}
