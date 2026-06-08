import type { Metadata } from "next";
import { MarketingShell } from "../_marketing/shell";
import { FaqList } from "../_marketing/faq-list";

export const metadata: Metadata = {
  title: "常见问题 — 冰茶AI",
  description: "冰茶AI 使用中的常见问题解答：家庭组进组、客户端接管、卡密与额度等。",
};

type FaqItem = { id: string; category: string; question: string; answer: string; sortOrder: number };

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
    <MarketingShell anim={false}>
      <section className="mkt-section mkt-section--tight">
        <div className="mkt-wrap">
          <div className="mkt-pagehead">
            <span className="mkt-pagehead__eyebrow">/ 常见问题</span>
            <h1>常见问题</h1>
            <p>使用中遇到问题？在这里找到解答，或添加客服微信。</p>
          </div>
          <FaqList faqs={faqs} contactWechat={settings.contact_wechat} contactQrcodeUrl={settings.contact_qrcode_url} />
        </div>
      </section>
    </MarketingShell>
  );
}
