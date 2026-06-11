import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { CONSOLE_AUTH_COOKIE } from "@/lib/console/auth-cookie";

export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete(CONSOLE_AUTH_COOKIE);

  return NextResponse.json({ ok: true });
}
