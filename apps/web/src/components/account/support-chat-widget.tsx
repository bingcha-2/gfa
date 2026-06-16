"use client";

import "./support-chat-widget.css";

import { useEffect, useRef, useState } from "react";
import {
  Loader2Icon,
  MessageCircleIcon,
  SendIcon,
  XIcon,
} from "lucide-react";

import { useDict } from "@/lib/i18n/client";
import { getSupportConversation } from "@/lib/account/user-api";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  ticketId?: string | null;
}

let idCounter = 0;
const nextId = () => `m${Date.now()}_${idCounter++}`;

/**
 * SupportChatWidget — 客户端 AI 客服悬浮气泡。
 *
 * 启用判断走后端(SUPPORT_AGENT_ENABLED);未启用则整个组件不渲染。
 * 发消息打到 /api/account/support/chat(SSE 流式),逐字渲染 + 工具状态 + 升级卡片。
 */
export function SupportChatWidget() {
  const t = useDict().portalApp.support;

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [toolLabel, setToolLabel] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);

  // 探活 + 载历史(只做一次)。
  useEffect(() => {
    let alive = true;
    getSupportConversation()
      .then((res) => {
        if (!alive) return;
        setEnabled(res.enabled);
        if (res.conversation) {
          setConversationId(res.conversation.id);
          setMessages(
            res.conversation.messages.map((m) => ({
              id: nextId(),
              role: m.role === "USER" ? "user" : "assistant",
              content: m.content,
            })),
          );
        }
      })
      .catch(() => {
        if (alive) setEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 自动滚到底。
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, toolLabel, open]);

  function patch(id: string, fn: (m: ChatMessage) => ChatMessage) {
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    setToolLabel(null);

    const userMsg: ChatMessage = { id: nextId(), role: "user", content: text };
    const botId = nextId();
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: botId, role: "assistant", content: "" },
    ]);

    try {
      const res = await fetch("/api/account/support/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, message: text }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`bad status ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLine = frame
            .split("\n")
            .find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload) continue;
          let ev: any;
          try {
            ev = JSON.parse(payload);
          } catch {
            continue;
          }
          handleEvent(ev, botId);
        }
      }
    } catch {
      patch(botId, (m) => ({
        ...m,
        content: m.content || t.networkError,
      }));
    } finally {
      setSending(false);
      setToolLabel(null);
    }
  }

  function handleEvent(ev: any, botId: string) {
    switch (ev?.type) {
      case "meta":
        if (ev.conversationId) setConversationId(ev.conversationId);
        break;
      case "delta":
        setToolLabel(null);
        if (typeof ev.text === "string") {
          patch(botId, (m) => ({ ...m, content: m.content + ev.text }));
        }
        break;
      case "tool":
        setToolLabel(toolText(ev.name, t));
        break;
      case "done":
        if (ev.conversationId) setConversationId(ev.conversationId);
        patch(botId, (m) => ({ ...m, ticketId: ev.ticketId ?? null }));
        setToolLabel(null);
        break;
      case "error":
        patch(botId, (m) => ({
          ...m,
          content: m.content || ev.message || t.errorGeneric,
        }));
        setToolLabel(null);
        break;
    }
  }

  if (!enabled) return null;

  if (!open) {
    return (
      <button
        type="button"
        className="sc-bubble"
        aria-label={t.bubbleLabel}
        onClick={() => setOpen(true)}
      >
        <MessageCircleIcon className="size-6" />
      </button>
    );
  }

  return (
    <div className="sc-panel" role="dialog" aria-label={t.title}>
      <div className="sc-header">
        <div>
          <div className="sc-header-title">{t.title}</div>
          <div className="sc-header-sub">{t.subtitle}</div>
        </div>
        <button
          type="button"
          className="sc-header-close"
          aria-label="close"
          onClick={() => setOpen(false)}
        >
          <XIcon className="size-4" />
        </button>
      </div>

      <div className="sc-body" ref={bodyRef}>
        {messages.length === 0 && (
          <div className="sc-msg sc-msg--assistant">{t.greeting}</div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} msg={m} t={t} />
        ))}
        {toolLabel && (
          <div className="sc-tool">
            <Loader2Icon className="sc-spin" />
            {toolLabel}
          </div>
        )}
        {sending && !toolLabel && lastAssistantEmpty(messages) && (
          <div className="sc-tool">
            <Loader2Icon className="sc-spin" />
            {t.thinking}
          </div>
        )}
      </div>

      <div className="sc-footer">
        <textarea
          className="sc-input"
          value={input}
          placeholder={t.inputPlaceholder}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
        />
        <button
          type="button"
          className="sc-send"
          aria-label={t.send}
          disabled={sending || input.trim().length === 0}
          onClick={() => void send()}
        >
          {sending ? (
            <Loader2Icon className="sc-spin size-4" />
          ) : (
            <SendIcon className="size-4" />
          )}
        </button>
      </div>
    </div>
  );
}

function Bubble({
  msg,
  t,
}: {
  msg: ChatMessage;
  t: ReturnType<typeof useDict>["portalApp"]["support"];
}) {
  return (
    <>
      {msg.content && (
        <div className={`sc-msg sc-msg--${msg.role}`}>{msg.content}</div>
      )}
      {msg.ticketId && (
        <div className="sc-escalate">
          <div className="sc-escalate-title">{t.escalatedTitle}</div>
          <div>{t.escalatedDesc}</div>
          <a className="sc-escalate-link" href="/account/tickets">
            {t.viewTicket} →
          </a>
        </div>
      )}
    </>
  );
}

function lastAssistantEmpty(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  return !!last && last.role === "assistant" && last.content.length === 0;
}

function toolText(
  name: string,
  t: ReturnType<typeof useDict>["portalApp"]["support"],
): string {
  switch (name) {
    case "search_knowledge":
      return t.toolSearchKnowledge;
    case "get_my_profile":
      return t.toolGetProfile;
    case "get_my_subscriptions":
      return t.toolGetSubscriptions;
    case "get_my_orders":
      return t.toolGetOrders;
    case "create_support_ticket":
      return t.toolCreateTicket;
    default:
      return t.toolRunning;
  }
}
