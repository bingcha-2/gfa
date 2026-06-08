/** 营销站统一页脚（首页与所有子页共用）。 */
export function MarketingFooter() {
  return (
    <footer className="mkt-footer">
      <div className="mkt-footer__inner">
        <div className="mkt-footer__brand">
          <a href="/" className="mkt-brand">
            <img className="mkt-brand__mark" src="/bcai-icon.png" alt="冰茶AI" width={30} height={30} />
            冰茶AI
          </a>
          <p className="mkt-footer__desc">
            主流 AI 编程工具的官方账号接管工具。官方直连，不做中间人。
          </p>
        </div>
        <div className="mkt-footer__col">
          <h4>产品</h4>
          <a href="/download">下载客户端</a>
          <a href="/features">客户端功能</a>
          <a href="/quickstart">快速开始</a>
          <a href="/how-it-works">工作原理</a>
        </div>
        <div className="mkt-footer__col">
          <h4>帮助</h4>
          <a href="/faq">常见问题</a>
          <a href="https://bcai.store" target="_blank" rel="noopener noreferrer">冰茶商店 ↗</a>
          <a href="https://bcai.online" target="_blank" rel="noopener noreferrer">冰茶 API ↗</a>
          <a href="https://bcai.lol" target="_blank" rel="noopener noreferrer">冰茶终端 ↗</a>
        </div>
      </div>
      <div className="mkt-footer__bottom">
        <span>© 2026 冰茶AI · BingchaAI</span>
        <span>官方直连 · 不做中间人 · 代码不经过我们</span>
      </div>
    </footer>
  );
}
