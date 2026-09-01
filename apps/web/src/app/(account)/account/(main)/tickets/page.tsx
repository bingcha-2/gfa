import { getDict } from "@/lib/i18n/server";
import { PageHeader } from "@/components/account/page-header";
import { TicketsList } from "@/components/account/tickets-list";
import { TicketContact } from "@/components/account/ticket-contact";

export const dynamic = "force-dynamic";

// 客服微信/二维码与官网 FAQ 同源:公开端点 GET /console/faq/settings(siteSetting 表)。
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

export default async function TicketsPage() {
  const [dict, settings] = await Promise.all([getDict(), fetchSettings()]);
  const t = dict.portalApp;
  return (
    <div className="account-page">
      <PageHeader title={t.pages.ticketsTitle} />
      <TicketContact wechat={settings.contact_wechat} qrcodeUrl={settings.contact_qrcode_url} />
      <TicketsList />
    </div>
  );
}
