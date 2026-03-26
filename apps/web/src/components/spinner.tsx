"use client";

import React from "react";

/**
 * Inline CSS spinner — no extra deps.
 * Usage: <Spinner size={14} color="currentColor" />
 */
export function Spinner({
  size = 16,
  color = "currentColor",
  style,
}: {
  size?: number;
  color?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      aria-label="loading"
      height={size}
      role="status"
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        animation: "gfa-spin 0.75s linear infinite",
        flexShrink: 0,
        ...style,
      }}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle
        cx="12"
        cy="12"
        fill="none"
        r="10"
        stroke={color}
        strokeDasharray="40 24"
        strokeLinecap="round"
        strokeWidth="3"
      />
    </svg>
  );
}
