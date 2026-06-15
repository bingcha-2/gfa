/**
 * 入场动画门控（pre-paint）：在首帧绘制前，由内联脚本同步给 <html> 加
 * data-mkt-anim；隐藏起始态只在该属性下、且仅 prefers-reduced-motion: no-preference 时生效。
 *
 * 关键：脚本随 .mkt 一同位于 Hero 之前，解析到即同步执行，所以 Hero 的隐藏起始态
 * 在「第一帧」就已就位 - 内容绝不会先以可见态绘制、再被 JS 拉回隐藏，从而消除入场闪烁。
 * 无 JS / 爬虫：脚本不执行 → 无属性 → 内容停在完全可见的默认态，绝不空白。
 * 用 <html> 数据属性（而非 .mkt 的 className）承载，避免触发 React 水合类名不一致。
 */
const animInitScript = `(function(){try{document.documentElement.dataset.mktAnim="1";}catch(e){}})();`;

export function AnimReady() {
  return <script dangerouslySetInnerHTML={{ __html: animInitScript }} />;
}
