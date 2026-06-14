import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// 账号设置(改密码 / 退出)已并入「我的」中心(/account/me)。保留重定向兼容旧书签。
export default function SettingsRedirect() {
  redirect("/account/me?tab=security");
}
