import { NextResponse } from "next/server";

import { getBackendBaseUrl } from "@/lib/backend-url";

const FALLBACK_SETTINGS = {
  contact_name: "客服",
  contact_wechat: "18339526286",
  contact_qrcode_url: "/api/faq-images/mr-gan-wechat-qr.jpg",
};

/** Public, narrow proxy for the customer-service contact shown during purchase. */
export async function GET() {
  try {
    const response = await fetch(`${getBackendBaseUrl()}/console/faq/settings`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return NextResponse.json(FALLBACK_SETTINGS);

    const settings = (await response.json()) as Record<string, unknown>;
    return NextResponse.json({
      contact_name:
        typeof settings.contact_name === "string" && settings.contact_name.trim()
          ? settings.contact_name
          : FALLBACK_SETTINGS.contact_name,
      contact_wechat: FALLBACK_SETTINGS.contact_wechat,
      contact_qrcode_url:
        typeof settings.contact_qrcode_url === "string" && settings.contact_qrcode_url.trim()
          ? settings.contact_qrcode_url
          : FALLBACK_SETTINGS.contact_qrcode_url,
    });
  } catch {
    return NextResponse.json(FALLBACK_SETTINGS);
  }
}
