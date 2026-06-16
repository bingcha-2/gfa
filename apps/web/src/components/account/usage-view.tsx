"use client";

import { useState } from "react";

import { UsageCharts } from "@/components/account/usage-charts";
import { UsageModelTable } from "@/components/account/usage-model-table";
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
    <div className="account-usage-view account-workflow-grid account-workflow-grid--stack">
      <div className="account-summary-strip account-summary-strip--compact">
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
      </div>

      <UsageCharts days={days} />

      {/* 按模型汇总表(请求数/输入·输出·缓存/合计/官方API价/占比) */}
      <UsageModelTable key={`m-${days}`} days={days} />
    </div>
  );
}
