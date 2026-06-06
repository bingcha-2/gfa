import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "关于冰茶AI — 一键续杯，AI 编程工具官方账号接管",
  description:
    "冰茶AI 是一款桌面客户端，一键接管 Antigravity IDE、OpenAI Codex、Claude Code 等 AI 编程工具，使用官方订阅账号，无需 API Key，不降速不加价。",
  openGraph: {
    title: "关于冰茶AI — 一键续杯，AI 编程工具官方账号接管",
    description:
      "冰茶AI 是一款桌面客户端，一键接管 Antigravity IDE、OpenAI Codex、Claude Code 等 AI 编程工具，使用官方订阅账号，无需 API Key，不降速不加价。",
    type: "website",
    url: "https://bcai.lol/about",
  },
};

export default function AboutLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
