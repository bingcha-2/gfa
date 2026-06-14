"use client";

import { useState } from "react";

import { UsageCharts } from "@/components/account/usage-charts";
import { UsageTable } from "@/components/account/usage-table";
import type { UsageDays } from "@/lib/account/user-types";
import { useDict } from "@/lib/i18n/client";

/**
 * 历史记录页主体:一个共享的时间窗口分段控件,同时驱动统计图与明细表。
 */
export function UsageView() {
  const dict = useDict();
  const u = dict.portalApp.usage;

  const [days, setDays] = useState<UsageDays>(7);

  return (
    <div className="account-usage-view">
      <div className="account-segmented-control" role="group" aria-label={u.rangeAria}>
        {([
          [1, u.daysToday],
          [7, u.days7],
          [30, u.days30],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={days === value}
            onClick={() => setDays(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <UsageCharts days={days} />

      {/* key={days} 让切换窗口时明细表重挂以重置分页 */}
      <UsageTable key={days} days={days} />
    </div>
  );
}
