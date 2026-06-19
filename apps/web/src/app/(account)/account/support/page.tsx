import { redirect } from "next/navigation";

import { AccountShell } from "@/components/account/account-shell";
import { SupportChatPage } from "@/components/account/support-chat-page";
import { serverUserApi } from "@/lib/account/user-server-api";
import type { Customer } from "@/lib/account/user-types";

export const dynamic = "force-dynamic";

export default async function AccountSupportPage() {
  let customer: Customer;

  try {
    ({ customer } = await serverUserApi<{ customer: Customer }>("me"));
  } catch {
    redirect("/account/login?next=/account/support");
  }

  return (
    <AccountShell initialCustomer={customer} hideSupportWidget>
      <SupportChatPage />
    </AccountShell>
  );
}
