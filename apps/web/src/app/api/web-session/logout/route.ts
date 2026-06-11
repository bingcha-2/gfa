import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { USER_AUTH_COOKIE } from "../../../../lib/user-auth-cookie";

export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete(USER_AUTH_COOKIE);

  return NextResponse.json({ ok: true });
}
