"use client";

import { Button } from "@/components/ui/button";
import { LogOutIcon } from "lucide-react";
import { useAccount } from "./account-provider";
import { useDict } from "@/lib/i18n/client";

export function LogoutButton() {
  const { handleLogout } = useAccount();
  const dict = useDict();
  const t = dict.portalApp.actions;

  return (
    <Button
      variant="outline"
      onClick={handleLogout}
      className="gap-2"
    >
      <LogOutIcon className="size-4" />
      {t.logout}
    </Button>
  );
}
