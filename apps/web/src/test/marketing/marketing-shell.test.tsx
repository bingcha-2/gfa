import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";

import { MarketingFooter } from "@/components/marketing/footer";
import { MarketingNav } from "@/components/marketing/nav";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

vi.mock("next/navigation", () => ({
  usePathname: () => "/features",
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/lib/i18n/client", () => ({
  useDict: () => ({
    common: {
      brandName: "冰茶AI",
      downloadClient: "下载客户端",
      userCenter: "用户中心",
    },
    nav: {
      features: "功能",
      howItWorks: "工作原理",
      quickstart: "快速开始",
      faq: "常见问题",
      mainNav: "主导航",
      menu: "菜单",
      toggleTheme: "切换主题",
    },
    footer: {
      desc: "一个可控入口连接常用 AI 工具。",
      product: "产品",
      download: "下载",
      features: "功能",
      quickstart: "快速开始",
      howItWorks: "工作原理",
      help: "帮助",
      faq: "常见问题",
      account: "用户中心",
      api: "API",
      terminal: "终端",
      copyright: "Copyright",
      tagline: "BingchaAI",
    },
  }),
  useLocale: () => "zh-CN",
  setLocaleCookie: vi.fn(),
}));

describe("marketing shell redesign contracts", () => {
  it("keeps the marketing nav compact and marks active route", () => {
    render(<MarketingNav />);

    expect(document.querySelector(".mkt-nav")).toBeInTheDocument();
    expect(document.querySelector(".mkt-nav__links")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "功能" })).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("link", { name: /下载客户端/ })).toHaveAttribute("href", "/download");
  });

  it("renders a branded footer with product and help route groups", () => {
    render(<MarketingFooter />);

    expect(screen.getByRole("link", { name: /冰茶AI/ })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "下载" })).toHaveAttribute("href", "/download");
    expect(screen.getByRole("link", { name: "用户中心" })).toBeInTheDocument();
  });

  it("defines the shared mixed-layout marketing primitives", () => {
    const source = read("components/marketing/marketing.css");

    expect(source).toContain(".mkt-shell-grid");
    expect(source).toContain(".mkt-hero-media");
    expect(source).toContain(".mkt-feature-band");
    expect(source).toContain(".mkt-process");
    expect(source).toContain(".mkt-support-panel");
    expect(source).toContain(".mkt-download-matrix");
    expect(source).toContain(".mkt-final-cta");
  });
});
