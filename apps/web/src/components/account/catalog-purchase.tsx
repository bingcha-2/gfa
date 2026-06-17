"use client";

import { useMemo, useState } from "react";
import { LayersIcon, LockIcon } from "lucide-react";

import { AccountButton } from "./account-ui";
import { CatalogOrderDialog } from "./catalog-order-dialog";
import {
  computePurchase,
  type CatalogConfig,
  type Selection,
} from "@/lib/account/catalog-pricing";
import { formatPriceCents } from "@/lib/account/format-extensions";
import { fmt } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/client";

type Line = "pool" | "bind";

const SEAT_OPTIONS = [1, 2, 4, 8] as const;
const MAX_DEVICES = 20;

/**
 * Two-line catalog purchase (spec §3): 🟦 号池线 / 🟧 绑定线, both pure-selection
 * with a live total computed by the same `computePurchase` the server charges
 * with. `catalog` is the PUBLISHED config; the page fetches it and renders this.
 */
export function CatalogPurchase({ catalog }: { catalog: CatalogConfig }) {
  const dict = useDict();
  const t = dict.portalApp.billing;
  const c = t.catalog;

  const productName = (p: string) => c.productNames[p] ?? p;
  const levelName = (l: string) => c.levelNames[l] ?? l;

  // 默认进入绑定线(绑定模式置前并默认选中):锁定独享号更稳,作为首选。
  const [line, setLine] = useState<Line>("bind");

  // ── 号池线 state ────────────────────────────────────────────────────────────
  const tierKeys = useMemo(() => Object.keys(catalog.usageTiers), [catalog]);
  const [poolProducts, setPoolProducts] = useState<string[]>([]);
  const [usageTier, setUsageTier] = useState<string>(tierKeys[0] ?? "small");
  const [poolDevices, setPoolDevices] = useState(1);

  // ── 绑定线 state ────────────────────────────────────────────────────────────
  // product → chosen level (absent = product not selected on the bind line).
  const [bindLevels, setBindLevels] = useState<Record<string, string>>({});
  const shareCapacity = catalog.shareCapacity ?? 8;
  const seatOptions = useMemo(
    () => SEAT_OPTIONS.filter((n) => n <= shareCapacity),
    [shareCapacity],
  );
  const defaultShareSeats = seatOptions[seatOptions.length - 1] ?? 1;
  const [shareSeats, setShareSeats] = useState<number>(defaultShareSeats);
  const [bindDevices, setBindDevices] = useState(1);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<Selection | null>(null);

  // ── Build the current selection for the active line ─────────────────────────
  const selection: Selection =
    line === "pool"
      ? {
          line: "pool",
          products: poolProducts,
          usageTier,
          deviceLimit: poolDevices,
        }
      : {
          line: "bind",
          items: Object.entries(bindLevels).map(([product, level]) => ({
            product,
            level,
          })),
          shareSeats,
          deviceLimit: bindDevices,
        };

  // Live price: computePurchase throws on an empty/invalid selection (e.g. no
  // product / unpriced level) — treat that as "not ready" rather than crashing.
  const priced = useMemo(() => {
    try {
      const hasProduct =
        selection.line === "pool"
          ? selection.products.length > 0
          : selection.items.length > 0;
      if (!hasProduct) return null;
      return computePurchase(catalog, selection);
    } catch {
      return null;
    }
  }, [catalog, selection]);

  const emptyHint =
    line === "pool" ? c.emptyProducts : c.emptyBindLevels;

  function togglePoolProduct(product: string) {
    setPoolProducts((prev) =>
      prev.includes(product)
        ? prev.filter((p) => p !== product)
        : [...prev, product]
    );
  }

  function toggleBindProduct(product: string) {
    setBindLevels((prev) => {
      if (product in prev) {
        const next = { ...prev };
        delete next[product];
        return next;
      }
      // Default to the first available level for that product.
      const firstLevel = catalog.levels[product]?.[0];
      if (!firstLevel) return prev;
      return { ...prev, [product]: firstLevel };
    });
  }

  function setBindLevel(product: string, level: string) {
    setBindLevels((prev) => ({ ...prev, [product]: level }));
  }

  function checkout() {
    if (!priced) return;
    setPendingSelection(selection);
    setDialogOpen(true);
  }

  const dialogTitle =
    line === "pool" ? c.dialogTitlePool : c.dialogTitleBind;

  return (
    <div className="account-catalog" data-testid="account-catalog-purchase">
      {/* Line tabs */}
      <div className="account-catalog-tabs" role="tablist" aria-label={c.pageTitle}>
        <button
          type="button"
          role="tab"
          aria-selected={line === "bind"}
          className="account-catalog-tab"
          data-line="bind"
          onClick={() => setLine("bind")}
        >
          <LockIcon />
          <span className="account-catalog-tab__name">{c.lineBind}</span>
          <span className="account-catalog-tab__tag">{c.lineBindTag}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={line === "pool"}
          className="account-catalog-tab"
          data-line="pool"
          onClick={() => setLine("pool")}
        >
          <LayersIcon />
          <span className="account-catalog-tab__name">{c.linePool}</span>
          <span className="account-catalog-tab__tag">{c.linePoolTag}</span>
        </button>
      </div>

      <div className="account-catalog-body">
        {/* ── 绑定线 ─────────────────────────────────────────────────────────── */}
        {line === "bind" && (
          <div className="account-catalog-config" role="tabpanel">
            <p className="account-catalog-config__hint">{c.lineBindHint}</p>

            <Knob label={c.productsLabel} sub={c.productsHint}>
              <div className="account-bind-products">
                {catalog.products.map((product) => {
                  const selected = product in bindLevels;
                  const levels = catalog.levels[product] ?? [];
                  return (
                    <div
                      key={product}
                      className="account-bind-product"
                      data-selected={selected || undefined}
                    >
                      <button
                        type="button"
                        className="account-chip account-bind-product__toggle"
                        aria-pressed={selected}
                        onClick={() => toggleBindProduct(product)}
                      >
                        {productName(product)}
                      </button>
                      {selected && (
                        <div
                          className="account-chipset account-bind-product__levels"
                          role="radiogroup"
                          aria-label={`${productName(product)} ${c.levelLabel}`}
                        >
                          {levels.map((level) => (
                            <button
                              key={level}
                              type="button"
                              role="radio"
                              aria-checked={bindLevels[product] === level}
                              className="account-chip account-chip--sm"
                              onClick={() => setBindLevel(product, level)}
                            >
                              {levelName(level)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Knob>

            <Knob label={c.seatLabel}>
              <div className="account-chipset" role="radiogroup" aria-label={c.seatLabel}>
                {seatOptions.map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={shareSeats === n}
                    className="account-chip"
                    onClick={() => setShareSeats(n)}
                  >
                    {fmt(c.seatFraction, { n, capacity: shareCapacity })}
                  </button>
                ))}
              </div>
            </Knob>

            <Knob label={c.deviceLabel}>
              <Stepper
                value={bindDevices}
                onChange={setBindDevices}
                unit={(n) => fmt(c.deviceUnit, { n })}
                decLabel={c.decReduce}
                incLabel={c.incAdd}
              />
            </Knob>

            <Knob label={c.durationLabel}>
              <span className="account-catalog-static">
                {fmt(t.durationDays, { n: catalog.durationDays })}
              </span>
            </Knob>
          </div>
        )}

        {/* ── 号池线 ─────────────────────────────────────────────────────────── */}
        {line === "pool" && (
          <div className="account-catalog-config" role="tabpanel">
            <p className="account-catalog-config__hint">{c.linePoolHint}</p>

            <Knob label={c.productsLabel} sub={c.productsHint}>
              <div className="account-chipset" role="group" aria-label={c.productsLabel}>
                {catalog.products.map((product) => (
                  <button
                    key={product}
                    type="button"
                    className="account-chip"
                    aria-pressed={poolProducts.includes(product)}
                    onClick={() => togglePoolProduct(product)}
                  >
                    {productName(product)}
                  </button>
                ))}
              </div>
            </Knob>

            <Knob label={c.usageLabel}>
              <div className="account-chipset account-chipset--seg" role="radiogroup" aria-label={c.usageLabel}>
                {tierKeys.map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={usageTier === key}
                    className="account-chip"
                    onClick={() => setUsageTier(key)}
                  >
                    {key === "small" ? c.usageSmall : key === "large" ? c.usageLarge : key}
                  </button>
                ))}
              </div>
            </Knob>

            <Knob label={c.deviceLabel}>
              <Stepper
                value={poolDevices}
                onChange={setPoolDevices}
                unit={(n) => fmt(c.deviceUnit, { n })}
                decLabel={c.decReduce}
                incLabel={c.incAdd}
              />
            </Knob>

            <Knob label={c.durationLabel}>
              <span className="account-catalog-static">
                {fmt(t.durationDays, { n: catalog.durationDays })}
              </span>
            </Knob>
          </div>
        )}
      </div>

      {/* ── Live total + checkout ─────────────────────────────────────────────── */}
      <div className="account-catalog-summary">
        <div className="account-catalog-summary__price">
          <span>{c.totalLabel}</span>
          <strong data-testid="catalog-total">
            {priced ? formatPriceCents(priced.priceCents) : "—"}
          </strong>
          <em>{fmt(c.perCycle, { n: catalog.durationDays })}</em>
        </div>
        {!priced && <p className="account-catalog-summary__hint">{emptyHint}</p>}
        <AccountButton
          type="button"
          className="account-catalog-summary__cta"
          disabled={!priced}
          onClick={checkout}
        >
          {c.checkout}
        </AccountButton>
      </div>

      <CatalogOrderDialog
        selection={pendingSelection}
        title={dialogTitle}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
}

// ── Small presentational helpers ──────────────────────────────────────────────

function Knob({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="account-knob">
      <div className="account-knob__head">
        <span className="account-knob__label">{label}</span>
        {sub && <span className="account-knob__sub">{sub}</span>}
      </div>
      {children}
    </div>
  );
}

function Stepper({
  value,
  onChange,
  unit,
  decLabel,
  incLabel,
}: {
  value: number;
  onChange: (n: number) => void;
  unit: (n: number) => string;
  decLabel: string;
  incLabel: string;
}) {
  return (
    <div className="account-stepper">
      <button
        type="button"
        aria-label={decLabel}
        disabled={value <= 1}
        onClick={() => onChange(Math.max(1, value - 1))}
      >
        −
      </button>
      <span className="account-stepper__value" aria-live="polite">
        {unit(value)}
      </span>
      <button
        type="button"
        aria-label={incLabel}
        disabled={value >= MAX_DEVICES}
        onClick={() => onChange(Math.min(MAX_DEVICES, value + 1))}
      >
        +
      </button>
    </div>
  );
}
