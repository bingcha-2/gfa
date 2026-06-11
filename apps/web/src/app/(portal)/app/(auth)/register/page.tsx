import { getDict } from "@/lib/i18n/server";
import { AuthCard } from "@/components/portal/auth/auth-card";
import { RegisterForm } from "@/components/portal/auth/register-form";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const dict = await getDict();
  const t = dict.portalApp.pages;

  return (
    <AuthCard title={t.registerTitle} description={t.registerDesc}>
      <RegisterForm />
    </AuthCard>
  );
}
