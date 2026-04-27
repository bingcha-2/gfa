// @ts-nocheck
"use client"

import dynamic from "next/dynamic"

const AppSidebar = dynamic(() => import("@/components/app-sidebar").then(m => m.AppSidebar), { ssr: false })
const ChartAreaInteractive = dynamic(() => import("@/components/chart-area-interactive").then(m => m.ChartAreaInteractive), { ssr: false })
const DataTable = dynamic(() => import("@/components/data-table").then(m => m.DataTable), { ssr: false })
const SectionCards = dynamic(() => import("@/components/section-cards").then(m => m.SectionCards), { ssr: false })
const SiteHeader = dynamic(() => import("@/components/site-header").then(m => m.SiteHeader), { ssr: false })
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

import data from "./data.json"

export default function Page() {
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" />
      <SidebarInset>
        <SiteHeader />
        <div className="flex flex-1 flex-col">
          <div className="@container/main flex flex-1 flex-col gap-2">
            <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
              <SectionCards />
              <div className="px-4 lg:px-6">
                <ChartAreaInteractive />
              </div>
              <DataTable data={data} />
            </div>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
