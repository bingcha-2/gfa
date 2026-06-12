"use client";

import { toast } from "sonner";
import { FaqPanel } from "@/components/console/google-family/faq-panel";

export default function FaqPage() {
  return (
    <FaqPanel
      showToast={(type, msg) => {
        if (type === "success") toast.success(msg);
        else if (type === "error") toast.error(msg);
        else toast.info(msg);
      }}
    />
  );
}
