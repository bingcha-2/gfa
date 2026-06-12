import { redirect } from "next/navigation";

// 邀请返佣已下线：侧边栏入口已移除，此页重定向到账户首页。
// 原实现见 git 历史；后端返佣逻辑由 EPAY_REFERRAL_PERCENT=0 关闭。
export default function ReferralPage() {
  redirect("/account");
}
