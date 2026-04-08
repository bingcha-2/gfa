"use client";

import React, { useEffect, useState } from "react";

type ProcessingAnimationProps = {
  status: string;
};

export function ProcessingAnimation({ status }: ProcessingAnimationProps) {
  const [loadingText, setLoadingText] = useState("Initializing connection...");

  useEffect(() => {
    let timer: number;
    if (status === "QUEUED") {
      setLoadingText("Allocating resources...");
      timer = window.setTimeout(() => setLoadingText("Awaiting automation queue..."), 2500);
    } else if (status === "IN_PROGRESS" || status === "PROCESSING") {
      setLoadingText("Executing protocol...");
      timer = window.setTimeout(() => setLoadingText("Processing payload..."), 3500);
    } else {
      setLoadingText("Establishing handshake...");
    }
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px', gap: '24px' }}>
      <svg className="animate-spin" viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="10" opacity="0.25"></circle>
        <path d="M12 2v4"></path>
      </svg>

      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ color: 'var(--foreground-muted)', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Status: {status}
        </div>
        <div style={{ color: 'var(--foreground)', fontSize: '16px', fontWeight: 500 }}>
          {loadingText}
        </div>
        <div style={{ color: 'var(--foreground-muted)', fontSize: '13px', marginTop: '8px', fontFamily: 'monospace' }}>
          &gt; Please sit tight and do not close this window
        </div>
      </div>
    </div>
  );
}
