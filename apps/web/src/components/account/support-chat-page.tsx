import { SupportChatSurface } from "./support-chat-widget";

export function SupportChatPage() {
  return (
    <section className="support-page" aria-labelledby="support-page-title">
      <div className="support-page__header">
        <span className="support-page__eyebrow">AI 客服</span>
        <h1 id="support-page-title">在线客服</h1>
        <p>遇到额度、登录、订阅或客户端问题，可以在这里直接和 AI 助手聊。</p>
      </div>
      <SupportChatSurface mode="page" />
    </section>
  );
}
