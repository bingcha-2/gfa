"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircleIcon, XCircleIcon, XIcon } from "lucide-react";

import { AccountSkeleton } from "./account-ui";
import type { Selection } from "@/lib/account/catalog-pricing";
import { useDialogA11y } from "@/lib/account/use-dialog-a11y";
import { useDict } from "@/lib/i18n/client";

type ContactSettings = {
  name: string;
  wechat: string;
  qrcodeUrl: string;
};

const FALLBACK_QR_URL = "/api/faq-images/mr-gan-wechat-qr.jpg";
const SUPPORT_WECHAT = "18339526286";

/**
 * Online checkout is intentionally disabled. The purchase surface keeps the
 * selected plan visible behind the dialog, but never creates a payment order.
 * Instead it shows the centrally configured customer-service WeChat contact.
 */
export function CatalogOrderFlow({
  selection: _selection,
  onPaid: _onPaid,
  onRequestClose: _onRequestClose,
  onActiveChange,
}: {
  selection: Selection;
  onPaid?: () => void;
  onRequestClose?: () => void;
  onActiveChange?: (active: boolean) => void;
}) {
  const t = useDict().portalApp.billing;
  const [contact, setContact] = useState<ContactSettings | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    onActiveChange?.(false);
    let active = true;

    fetch("/api/contact-settings", { headers: { accept: "application/json" } })
      .then((response) => response.json())
      .then((settings: Record<string, unknown>) => {
        if (!active) return;
        setContact({
          name: typeof settings.contact_name === "string" ? settings.contact_name : "",
          wechat: SUPPORT_WECHAT,
          qrcodeUrl:
            typeof settings.contact_qrcode_url === "string" && settings.contact_qrcode_url.trim()
              ? settings.contact_qrcode_url
              : FALLBACK_QR_URL,
        });
      })
      .catch(() => {
        if (!active) return;
        setContact({ name: "客服", wechat: SUPPORT_WECHAT, qrcodeUrl: FALLBACK_QR_URL });
      });

    return () => {
      active = false;
      onActiveChange?.(false);
    };
  }, [onActiveChange]);

  return (
    <div className="account-order-flow account-order-flow--contact">
      <div className="account-order-flow__failure" role="alert">
        <XCircleIcon aria-hidden="true" />
        <div>
          <strong>{t.failedTitle}</strong>
          <p>{t.wechatPurchaseDesc}</p>
        </div>
      </div>

      {!contact ? (
        <div className="account-order-flow__loading">
          <AccountSkeleton className="account-skeleton--qr" />
          <p>{t.wechatLoading}</p>
        </div>
      ) : (
        <div className="account-order-flow__wechat">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={contact.qrcodeUrl}
            alt={t.wechatQrAlt}
            className="account-order-flow__qr account-order-flow__qr--wechat"
          />
          <div className="account-order-flow__wechat-heading">
            <MessageCircleIcon aria-hidden="true" />
            <strong>{t.wechatScanHint}</strong>
          </div>
          <div className="account-order-flow__wechat-contact">
            <span>{t.wechatIdLabel}</span>
            <code>{contact.wechat}</code>
            <button
              type="button"
              onClick={() => {
                if (!navigator.clipboard) return;
                navigator.clipboard.writeText(contact.wechat).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2000);
                }).catch(() => {});
              }}
            >
              {copied ? t.wechatCopied : t.wechatCopy}
            </button>
          </div>
          <p className="account-order-flow__contact-note">{t.wechatPurchaseNote}</p>
        </div>
      )}
    </div>
  );
}

export function CatalogOrderDialog({
  selection,
  title,
  open,
  onOpenChange,
  onPaid,
}: {
  selection: Selection | null;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPaid?: () => void;
}) {
  const t = useDict().portalApp.billing;
  const panelRef = useRef<HTMLElement>(null);
  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);
  useDialogA11y(panelRef, open && !!selection, handleClose);

  if (!open || !selection) return null;

  return (
    <div className="account-dialog" role="presentation">
      <button
        type="button"
        className="account-dialog__backdrop"
        aria-label={t.closeDialog}
        onClick={handleClose}
      />
      <section
        ref={panelRef}
        tabIndex={-1}
        className="account-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-catalog-dialog-title"
      >
        <header className="account-dialog__header">
          <div>
            <h2 id="account-catalog-dialog-title">{t.dialogTitle}</h2>
            <p>{title}</p>
          </div>
          <button
            type="button"
            className="account-dialog__close"
            aria-label={t.closeDialog}
            onClick={handleClose}
          >
            <XIcon size={16} />
          </button>
        </header>
        <CatalogOrderFlow selection={selection} onPaid={onPaid} />
      </section>
    </div>
  );
}
