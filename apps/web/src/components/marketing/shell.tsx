import type { ReactNode } from "react";
import "./marketing.css";
import { MarketingNav } from "./nav";
import { MarketingFooter } from "./footer";
import { AnimReady } from "./anim-ready";
import { themeInitScript } from "./theme-toggle";

/**
 * 营销站统一外壳：主题初始化脚本 + .mkt 作用域 + 顶部导航 + 页脚。
 * 首页与所有子页共用，保证视觉与深浅模式一致。
 */
export function MarketingShell({ children, anim = true }: { children: ReactNode; anim?: boolean }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      <div className="mkt" id="top">
        {anim && <AnimReady />}
        <MarketingNav />
        {children}
        <MarketingFooter />
      </div>
    </>
  );
}
