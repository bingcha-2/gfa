import React, { useRef, useState } from "react";
import { RedeemForm, type RedeemSuccessPayload } from "./redeem-form";
import { UltraSwapFlow } from "./ultra-swap-flow";
import { MigrationCheckForm } from "./migration-check-form";
import { RosettaPanel } from "./rosetta-panel";
import { getVsCodeApi } from "../lib/vscode-api";

export function PublicPortal() {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    rosetta: false,
    ultra: false,
    swap: false,
    support: false,
  });

  // Track which sections have been opened at least once (lazy mount)
  const mountedRef = useRef<Record<string, boolean>>({
    rosetta: false,
    ultra: false,
    swap: false,
    support: false,
  });

  function toggleSection(key: string) {
    setExpandedSections((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (next[key]) {
        mountedRef.current[key] = true;
      }
      return next;
    });
  }

  function handleSubmitSuccess(_payload: RedeemSuccessPayload) {
    // success handled silently
  }

  function openExternal(url: string) {
    const api = getVsCodeApi();
    if (api) {
      api.postMessage({ type: "openExternal", payload: { url } });
    } else {
      window.open(url, "_blank");
    }
  }

  return (
    <div className="stacked-portal">
      {/* FAQ quick link */}
      <section className="portal-section">
        <button className="store-banner-btn faq" onClick={() => openExternal("https://bcai.site/faq")} style={{ width: "100%" }}>
          <span className="store-banner-icon">❓</span>
          <span className="store-banner-text">
            <strong>常见问题</strong>
            <small>使用遇到问题？点此查看解答</small>
          </span>
          <span className="store-banner-arrow">→</span>
        </button>
      </section>

      <div className="portal-divider" />

      {/* Section 0: 账号管理 (Rosetta) */}
      <section className="portal-section">
        <div
          className={`portal-section-header portal-section-toggle${expandedSections.rosetta ? " expanded" : ""}`}
          onClick={() => toggleSection("rosetta")}
        >
          <span className="portal-section-icon">🛰️</span>
          <h2 className="portal-section-title">账号管理</h2>
          <span className="portal-section-chevron">{expandedSections.rosetta ? "▾" : "▸"}</span>
        </div>
        {mountedRef.current.rosetta && (
          <div style={{ display: expandedSections.rosetta ? undefined : "none" }}>
            <RosettaPanel />
          </div>
        )}
      </section>

      <div className="portal-divider" />

      {/* Section 1: 获取ULTRA */}
      <section className="portal-section">
        <div
          className={`portal-section-header portal-section-toggle${expandedSections.ultra ? " expanded" : ""}`}
          onClick={() => toggleSection("ultra")}
        >
          <span className="portal-section-icon">💎</span>
          <h2 className="portal-section-title">获取ULTRA</h2>
          <span className="portal-section-chevron">{expandedSections.ultra ? "▾" : "▸"}</span>
        </div>
        {mountedRef.current.ultra && (
          <div style={{ display: expandedSections.ultra ? undefined : "none" }}>
            <RedeemForm onSuccess={handleSubmitSuccess} />
          </div>
        )}
      </section>

      <div className="portal-divider" />

      {/* Section 2: ULTRA续杯 */}
      <section className="portal-section">
        <div
          className={`portal-section-header portal-section-toggle${expandedSections.swap ? " expanded" : ""}`}
          onClick={() => toggleSection("swap")}
        >
          <span className="portal-section-icon">🔄</span>
          <h2 className="portal-section-title">ULTRA续杯</h2>
          <span className="portal-section-chevron">{expandedSections.swap ? "▾" : "▸"}</span>
        </div>
        {mountedRef.current.swap && (
          <div style={{ display: expandedSections.swap ? undefined : "none" }}>
            <UltraSwapFlow />
          </div>
        )}
      </section>

      <div className="portal-divider" />

      {/* Section 3: 自助售后 */}
      <section className="portal-section">
        <div
          className={`portal-section-header portal-section-toggle${expandedSections.support ? " expanded" : ""}`}
          onClick={() => toggleSection("support")}
        >
          <span className="portal-section-icon">🛠️</span>
          <h2 className="portal-section-title">自助售后</h2>
          <span className="portal-section-chevron">{expandedSections.support ? "▾" : "▸"}</span>
        </div>
        {mountedRef.current.support && (
          <div style={{ display: expandedSections.support ? undefined : "none" }}>
            <MigrationCheckForm />
          </div>
        )}
      </section>

      <div className="portal-divider" />

      {/* Quick Links (底部) */}
      <section className="portal-section">
        <div className="store-banner-row">
          <button className="store-banner-btn" onClick={() => openExternal("https://bcai.store")}>
            <span className="store-banner-icon">🍵</span>
            <span className="store-banner-text">
              <strong>冰茶商店</strong>
              <small>bcai.store</small>
            </span>
            <span className="store-banner-arrow">→</span>
          </button>
          <button className="store-banner-btn api" onClick={() => openExternal("https://bcai.online")}>
            <span className="store-banner-icon">⚡</span>
            <span className="store-banner-text">
              <strong>冰茶API</strong>
              <small>bcai.online</small>
            </span>
            <span className="store-banner-arrow">→</span>
          </button>
        </div>
      </section>
    </div>
  );
}

