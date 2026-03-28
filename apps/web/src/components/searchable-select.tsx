"use client";

import { useState, useRef, useEffect } from "react";

type Option = {
  value: string;
  label: string;
};

type SearchableSelectProps = {
  id?: string;
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
};

/**
 * A searchable dropdown that filters options as the user types.
 * Falls back to a plain text input + dropdown list (no native <select>).
 */
export function SearchableSelect({
  id,
  options,
  value,
  onChange,
  placeholder = "-- 请选择 --",
  disabled = false,
}: SearchableSelectProps) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Resolve display label for the currently selected value
  const selectedLabel = options.find((o) => o.value === value)?.label ?? "";

  // Filter options by search keyword
  const filtered = search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  // Close dropdown on outside click
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        id={id}
        type="text"
        disabled={disabled}
        placeholder={value ? selectedLabel : placeholder}
        value={open ? search : (value ? selectedLabel : "")}
        onFocus={() => { setOpen(true); setSearch(""); }}
        onChange={(e) => { setSearch(e.target.value); if (!open) setOpen(true); }}
        autoComplete="off"
        style={{
          width: "100%",
          boxSizing: "border-box",
          cursor: disabled ? "not-allowed" : "pointer",
          color: value && !open ? "inherit" : undefined,
        }}
      />
      {/* Dropdown arrow indicator */}
      <span
        style={{
          position: "absolute",
          right: 10,
          top: "50%",
          transform: "translateY(-50%)",
          pointerEvents: "none",
          fontSize: "0.65rem",
          color: "var(--foreground-muted, #a3a3a3)",
        }}
      >
        ▼
      </span>
      {open && (
        <ul
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            maxHeight: 240,
            overflowY: "auto",
            margin: 0,
            padding: 0,
            listStyle: "none",
            background: "var(--bg-panel, #fff)",
            border: "1px solid var(--border, rgba(0,0,0,0.12))",
            borderRadius: "0.375rem",
            zIndex: 50,
            boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
          }}
        >
          {/* Clear option */}
          <li
            onMouseDown={(e) => {
              e.preventDefault();
              onChange("");
              setOpen(false);
              setSearch("");
            }}
            style={{
              padding: "0.5rem 0.75rem",
              fontSize: "0.85rem",
              cursor: "pointer",
              color: "var(--foreground-muted, #a3a3a3)",
              fontStyle: "italic",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLLIElement).style.background = "rgba(0,0,0,0.04)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLLIElement).style.background = "transparent";
            }}
          >
            {placeholder}
          </li>
          {filtered.length === 0 ? (
            <li
              style={{
                padding: "0.75rem",
                fontSize: "0.85rem",
                color: "var(--foreground-muted, #a3a3a3)",
                textAlign: "center",
              }}
            >
              无匹配结果
            </li>
          ) : (
            filtered.map((opt) => (
              <li
                key={opt.value}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(opt.value);
                  setOpen(false);
                  setSearch("");
                }}
                style={{
                  padding: "0.5rem 0.75rem",
                  fontSize: "0.85rem",
                  cursor: "pointer",
                  background: opt.value === value ? "rgba(13,148,136,0.1)" : "transparent",
                  color: opt.value === value ? "var(--accent, #0d9488)" : "inherit",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLLIElement).style.background =
                    opt.value === value ? "rgba(13,148,136,0.15)" : "rgba(0,0,0,0.04)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLLIElement).style.background =
                    opt.value === value ? "rgba(13,148,136,0.1)" : "transparent";
                }}
              >
                {opt.label}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
