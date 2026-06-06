import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { Geist, Geist_Mono } from "next/font/google";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";

const fontSans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const fontMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400"] });

export const metadata: Metadata = {
  title: "冰茶AI — 一键续杯，AI 编程工具官方账号接管",
  description: "冰茶AI 是一款桌面客户端，一键接管 Antigravity IDE、OpenAI Codex、Claude Code 等 AI 编程工具，使用官方订阅账号，无需 API Key，不降速不加价。",
  icons: {
    icon: "/bcai-icon.png",
    apple: "/bcai-icon.png",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={cn(fontSans.variable, fontMono.variable)}
    >
      <body className="antialiased" suppressHydrationWarning>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
