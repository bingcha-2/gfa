import { Suspense } from "react";
import { getDict } from "@/lib/i18n/server";
import { AuthCard } from "@/components/portal/auth/auth-card";
import { ResetForm } from "@/components/portal/auth/reset-form";

export const dynamic = "force-dynamic";

export default async function ResetPage() {
  const dict = await getDict();
  const t = dict.portalApp.pages;

  return (
    <AuthCard title={t.resetTitle} description={t.resetDesc}>
      {/* ResetForm reads searchParams — wrap in Suspense */}
      <Suspense>
        <ResetForm />
      </Suspense>
    </AuthCard>
  );
}
