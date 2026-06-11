import { getDict } from "@/lib/i18n/server";
import { AuthCard } from "@/components/account/auth/auth-card";
import { ForgotForm } from "@/components/account/auth/forgot-form";

export const dynamic = "force-dynamic";

export default async function ForgotPage() {
  const dict = await getDict();
  const t = dict.portalApp.pages;

  return (
    <AuthCard title={t.forgotTitle} description={t.forgotDesc}>
      <ForgotForm />
    </AuthCard>
  );
}
