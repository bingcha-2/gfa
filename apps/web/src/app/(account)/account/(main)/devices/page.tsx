import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// 设备管理已并入「我的」中心(/account/me)。保留此路由重定向,兼容旧书签。
export default function DevicesRedirect() {
  redirect("/account/me?tab=devices");
}
