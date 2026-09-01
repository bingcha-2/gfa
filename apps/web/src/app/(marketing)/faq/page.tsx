import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/shell";
import { FaqList } from "@/components/marketing/faq-list";
import { getDict } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getDict();
  return { title: t.meta.faqTitle, description: t.meta.faqDescription };
}

type FaqItem = { id: string; category: string; question: string; answer: string; sortOrder: number };

async function fetchFaqs(): Promise<FaqItem[]> {
  const base = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";
  try {
    const res = await fetch(`${base}/console/faq`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

async function fetchSettings(): Promise<Record<string, string>> {
  const base = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";
  try {
    const res = await fetch(`${base}/console/faq/settings`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (!res.ok) return {};
    return res.json();
  } catch {
    return {};
  }
}

export default async function FaqRoute() {
  const [faqs, settings, t] = await Promise.all([fetchFaqs(), fetchSettings(), getDict()]);
  return (
    <MarketingShell anim={false}>
      <section className="mkt-section mkt-section--tight">
        <div className="mkt-wrap">
          <div className="mkt-pagehead">
            <span className="mkt-pagehead__eyebrow">{t.faqPage.eyebrow}</span>
            <h1>{t.faqPage.title}</h1>
            <p>{t.faqPage.sub}</p>
          </div>
          <div className="mkt-support-panel">
            <FaqList faqs={faqs} contactWechat={settings.contact_wechat} contactQrcodeUrl={settings.contact_qrcode_url} />
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
