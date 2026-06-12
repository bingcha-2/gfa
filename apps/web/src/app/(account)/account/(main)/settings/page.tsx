import { getDict } from "@/lib/i18n/server";
import { PageHeader } from "@/components/account/page-header";
import { ChangePasswordForm } from "@/components/account/auth/change-password-form";
import { LogoutButton } from "@/components/account/logout-button";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const dict = await getDict();
  const t = dict.portalApp;

  return (
    <div className="account-settings" data-testid="account-settings">
      <PageHeader title={t.pages.settingsTitle} />

      <section className="account-settings-panel">
        <div>
          <h3>{t.settings.changePwdSection}</h3>
          <p>
            {t.settings.changePwdDesc}
          </p>
        </div>
        <ChangePasswordForm />
      </section>

      <section className="account-settings-panel">
        <div>
          <h3>{t.settings.logoutSection}</h3>
          <p>
            {t.settings.logoutDesc}
          </p>
        </div>
        <LogoutButton />
      </section>
    </div>
  );
}
