"use client";

import { useEffect } from "react";

/**
 * 入场动画门控：挂载后给 .mkt 根加 `mkt-anim` 类，动画的隐藏起始态只在此类下生效。
 * 这样无 JS / SSR / 爬虫的默认渲染是「完全可见」的，绝不会因动画未触发而 ship 空白。
 */
export function AnimReady() {
  useEffect(() => {
    // useEffect 在首帧绘制后才运行，因此「完全可见」的默认态必定先绘制过一次，
    // 再加 mkt-anim 进入编排。无 JS / SSR / 爬虫永远停在可见态，绝不空白。
    document.querySelector(".mkt")?.classList.add("mkt-anim");
  }, []);
  return null;
}
