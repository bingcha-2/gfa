import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getDict } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getDict();
  return { title: t.meta.downloadTitle, description: t.meta.downloadDescription };
}

export default function DownloadLayout({ children }: { children: ReactNode }) {
  return children;
}
