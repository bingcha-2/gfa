import { getDict } from "@/lib/i18n/server";
import { AuthCard } from "@/components/portal/auth/auth-card";
import { LoginForm } from "@/components/portal/auth/login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const dict = await getDict();
  const t = dict.portalApp.pages;

  return (
    <AuthCard title={t.loginTitle} description={t.loginDesc}>
      <LoginForm />
    </AuthCard>
  );
}
