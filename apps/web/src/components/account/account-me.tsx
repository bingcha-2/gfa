"use client";

import { useState } from "react";
import { MonitorSmartphoneIcon, ShieldCheckIcon } from "lucide-react";

import { ChangePasswordForm } from "@/components/account/auth/change-password-form";
import { DevicesPanel } from "@/components/account/devices-panel";
import { LogoutButton } from "@/components/account/logout-button";
import { useDict } from "@/lib/i18n/client";

type MeTab = "devices" | "security";

/**
 * 「我的」中心:把原顶栏「设备」与下拉「设置」(改密码 + 退出)合并为一个 Tab 容器。
 */
export function AccountMe({ initialTab = "devices" }: { initialTab?: MeTab }) {
  const dict = useDict();
  const t = dict.portalApp;
  const m = t.me;

  const [tab, setTab] = useState<MeTab>(initialTab);

  const tabs: { id: MeTab; label: string; icon: React.ReactNode }[] = [
    { id: "devices", label: m.tabDevices, icon: <MonitorSmartphoneIcon className="size-4" /> },
    { id: "security", label: m.tabSecurity, icon: <ShieldCheckIcon className="size-4" /> },
  ];

  return (
    <div className="account-me-tabs">
      <div className="account-tabs" role="tablist" aria-label={t.pages.meTitle}>
        {tabs.map((it) => (
          <button
            key={it.id}
            type="button"
            role="tab"
            id={`account-me-tab-${it.id}`}
            aria-selected={tab === it.id}
            aria-controls={`account-me-panel-${it.id}`}
            className="account-tab"
            data-active={tab === it.id || undefined}
            onClick={() => setTab(it.id)}
          >
            {it.icon}
            {it.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`account-me-panel-${tab}`}
        aria-labelledby={`account-me-tab-${tab}`}
        className="account-tabpanel"
      >
        {tab === "devices" ? (
          <DevicesPanel />
        ) : (
          <div className="account-settings">
            <section className="account-settings-panel">
              <div>
                <h3>{t.settings.changePwdSection}</h3>
                <p>{t.settings.changePwdDesc}</p>
              </div>
              <ChangePasswordForm />
            </section>

            <section className="account-settings-panel">
              <div>
                <h3>{t.settings.logoutSection}</h3>
                <p>{t.settings.logoutDesc}</p>
              </div>
              <LogoutButton />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
