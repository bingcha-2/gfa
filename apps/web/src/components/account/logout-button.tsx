"use client";

import { LogOutIcon } from "lucide-react";
import { AccountButton } from "./account-ui";
import { useAccount } from "./account-provider";
import { useDict } from "@/lib/i18n/client";

export function LogoutButton() {
  const { handleLogout } = useAccount();
  const dict = useDict();
  const t = dict.portalApp.actions;

  return (
    <AccountButton variant="secondary" onClick={handleLogout}>
      <LogOutIcon data-icon="inline-start" />
      {t.logout}
    </AccountButton>
  );
}
