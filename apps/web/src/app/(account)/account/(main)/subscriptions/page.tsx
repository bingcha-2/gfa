import { PageHeader } from "@/components/account/page-header";
import { SubscriptionsPanel } from "@/components/account/subscriptions-panel";

export const dynamic = "force-dynamic";

export default function SubscriptionsPage() {
  return (
    <div className="account-page">
      <PageHeader
        title="我的订阅"
        description="账户名下的全部订阅。排在前面的优先消耗,用完自动接力到下一个 —— 用 ↑ ↓ 调整顺序。"
      />
      <SubscriptionsPanel />
    </div>
  );
}
