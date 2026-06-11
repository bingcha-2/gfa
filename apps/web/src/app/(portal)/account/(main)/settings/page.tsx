import { getDict } from "@/lib/i18n/server";
import { PageHeader } from "@/components/portal/page-header";
import { ChangePasswordForm } from "@/components/portal/auth/change-password-form";
import { LogoutButton } from "@/components/portal/logout-button";
import { Separator } from "@/components/ui/separator";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const dict = await getDict();
  const t = dict.portalApp;

  return (
    <div className="space-y-8 max-w-2xl">
      <PageHeader title={t.pages.settingsTitle} />

      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">{t.settings.changePwdSection}</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t.settings.changePwdDesc}
          </p>
        </div>
        <ChangePasswordForm />
      </section>

      <Separator />

      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">{t.settings.logoutSection}</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t.settings.logoutDesc}
          </p>
        </div>
        <LogoutButton />
      </section>
    </div>
  );
}
