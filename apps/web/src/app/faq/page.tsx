import type { Metadata } from "next";
import { FaqPage } from "../../components/faq-page";
import { PublicShell } from "../../components/public-shell";

export const metadata: Metadata = {
  title: "常见问题 - BingCha AI",
  description: "BingCha AI 使用中的常见问题解答：家庭组进组、反重力使用、Antigravity Tools 等。",
};

type FaqItem = {
  id: string;
  category: string;
  question: string;
  answer: string;
  sortOrder: number;
};

async function fetchFaqs(): Promise<FaqItem[]> {
  const base = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";
  try {
    const res = await fetch(`${base}/faq`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

async function fetchSettings(): Promise<Record<string, string>> {
  const base = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";
  try {
    const res = await fetch(`${base}/faq/settings`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (!res.ok) return {};
    return res.json();
  } catch {
    return {};
  }
}

export default async function FaqRoute() {
  const [faqs, settings] = await Promise.all([fetchFaqs(), fetchSettings()]);
  return (
    <PublicShell>
      <div style={{ padding: "32px 0" }}>
        <FaqPage faqs={faqs} contactWechat={settings.contact_wechat} contactQrcodeUrl={settings.contact_qrcode_url} />
      </div>
    </PublicShell>
  );
}


