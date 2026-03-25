import Link from "next/link";

import { OrderStatusPanel } from "../../../components/order-status-panel";

type StatusPageProps = {
  params: Promise<{
    orderNo: string;
  }>;
};

export default async function StatusPage({ params }: StatusPageProps) {
  const { orderNo } = await params;

  return (
    <main className="page-shell compact">
      <nav className="nav-strip">
        <div className="nav-brand">
          <div className="nav-mark">GO</div>
          <span>Invite Status</span>
        </div>

        <div className="nav-links">
          <Link className="pill-link" href="/status">
            按卡密查询
          </Link>
          <Link className="pill-link" href="/redeem">
            提交新订单
          </Link>
        </div>
      </nav>

      <section className="content-grid">
        <article className="glass-panel">
          <div className="panel-stack">
            <div>
              <p className="label">Tracking</p>
              <h1 className="section-title">订单 {orderNo}</h1>
              <p className="muted">
                这个页面会自动刷新。你只需要关注当前状态，以及系统有没有成功把邀请发出去。
              </p>
            </div>

            <div className="list-stack">
              <div className="list-card">
                <h4>状态会自动轮询</h4>
                <p>如果订单还在排队或执行中，不需要手动刷新页面。</p>
              </div>
              <div className="list-card">
                <h4>成功口径固定</h4>
                <p>当前以“邀请已发出”作为成功标准，不要求用户已经加入家庭组。</p>
              </div>
              <div className="list-card">
                <h4>返回查询页</h4>
                <p>如果你在当前浏览器提交过卡密，也可以回到查询页按卡密直接找回这笔订单。</p>
              </div>
            </div>
          </div>
        </article>

        <OrderStatusPanel orderNo={orderNo} />
      </section>
    </main>
  );
}
