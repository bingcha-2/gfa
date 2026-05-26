import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

function getDataDir(): string {
  if (process.env.ROSETTA_DATA_DIR) return process.env.ROSETTA_DATA_DIR;
  return path.resolve(process.cwd(), "data");
}

const ANNOUNCEMENT_FILE = path.join(getDataDir(), "announcement.txt");

// GET /api/remote-token/announcement — public, returns plain text
export async function GET() {
  try {
    if (!fs.existsSync(ANNOUNCEMENT_FILE)) {
      return new NextResponse("", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const text = fs.readFileSync(ANNOUNCEMENT_FILE, "utf-8").trim();
    return new NextResponse(text, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch {
    return new NextResponse("", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

// POST /api/remote-token/announcement — requires console session cookie
export async function POST(request: NextRequest) {
  // Verify console auth via cookie
  const token = request.cookies.get("console_token")?.value;
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Validate the token against the API
  try {
    const apiBase = process.env.API_BASE_URL || "http://127.0.0.1:3000";
    const res = await fetch(`${apiBase}/api/console/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "Auth check failed" }, { status: 500 });
  }

  try {
    const body = await request.json();
    const text = String(body.text || "").trim();

    const dir = getDataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(ANNOUNCEMENT_FILE, text, "utf-8");
    return NextResponse.json({ success: true, text });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save announcement" },
      { status: 500 }
    );
  }
}
