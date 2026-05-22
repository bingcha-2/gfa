import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "下载冰茶AI客户端",
  description: "下载冰茶AI续杯客户端，支持 Windows 和 macOS",
};

export default function DownloadLayout({ children }: { children: ReactNode }) {
  return children;
}
