import Link from "next/link";

import { OrderStatusPanel } from "../../../components/order-status-panel";
import { fmt } from "@/lib/i18n";
import { getDict } from "@/lib/i18n/server";

type StatusPageProps = {
  params: Promise<{
    orderNo: string;
  }>;
};

export default async function StatusPage({ params }: StatusPageProps) {
  const { orderNo } = await params;
  const t = await getDict();

  return (
    <main className="page-shell compact">
      <nav className="nav-strip">
        <div className="nav-brand">
          <div className="nav-mark">GO</div>
          <span>{t.orderPage.navBrand}</span>
        </div>

        <div className="nav-links">
          <Link className="pill-link" href="/status">
            {t.orderPage.lookupByCode}
          </Link>
          <Link className="pill-link" href="/redeem">
            {t.orderPage.submitNew}
          </Link>
        </div>
      </nav>

      <section className="content-grid">
        <article className="glass-panel">
          <div className="panel-stack">
            <div>
              <p className="label">{t.orderPage.trackingLabel}</p>
              <h1 className="section-title">{fmt(t.orderPage.orderTitle, { orderNo })}</h1>
              <p className="muted">
                {t.orderPage.orderDesc}
              </p>
            </div>

            <div className="list-stack">
              <div className="list-card">
                <h4>{t.orderPage.card1Title}</h4>
                <p>{t.orderPage.card1Desc}</p>
              </div>
              <div className="list-card">
                <h4>{t.orderPage.card2Title}</h4>
                <p>{t.orderPage.card2Desc}</p>
              </div>
              <div className="list-card">
                <h4>{t.orderPage.card3Title}</h4>
                <p>{t.orderPage.card3Desc}</p>
              </div>
            </div>
          </div>
        </article>

        <OrderStatusPanel orderNo={orderNo} />
      </section>
    </main>
  );
}
