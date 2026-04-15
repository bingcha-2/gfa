"use client";

import { usePathname } from "next/navigation";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";

const SECTION_LABELS: Record<string, string> = {
  "": "总览",
  "daily-stats": "数据汇总",
  accounts: "母号池",
  groups: "家庭组",
  orders: "订单",
  tasks: "任务",
  codes: "卡密",
  expire: "到期扫描",
  scheduler: "自动维护",
  lookup: "成员管理",
  users: "用户管理",
  settings: "修改密码",
};

export function SiteHeader() {
  const pathname = usePathname();

  // Extract the section from the pathname: /console/accounts → "accounts"
  const segments = pathname.replace(/^\/+/, "").split("/");
  const sectionSlug = segments.length > 1 ? segments[1] : "";
  const sectionLabel = SECTION_LABELS[sectionSlug] ?? "控制台";

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-2 h-4 data-vertical:self-auto"
        />
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage>{sectionLabel}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    </header>
  );
}
