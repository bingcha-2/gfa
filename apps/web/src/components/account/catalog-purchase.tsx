"use client";

import { useMemo, useState } from "react";

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

const SEAT_OPTIONS = [1, 2, 4, 8] as const;
const MAX_DEVICES = 20;

export function CatalogPurchase({ catalog }: { catalog: CatalogConfig }) {
  const dict = useDict();
  const t = dict.portalApp.billing;
  const c = t.catalog;

  const productName = (p: string) => c.productNames[p] ?? p;
  const levelName = (l: string) => c.levelNames[l] ?? l;

  const [bindLevels, setBindLevels] = useState<Record<string, string>>({});
  const shareCapacity = catalog.shareCapacity ?? 8;
  const seatOptions = useMemo(
    () => SEAT_OPTIONS.filter((n) => n <= shareCapacity),
    [shareCapacity],
  );
  const [shareSeats, setShareSeats] = useState<number>(seatOptions[0] ?? 1);
  const [bindDevices, setBindDevices] = useState(1);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<Selection | null>(null);

  const selection: Selection = {
    line: "bind",
    items: Object.entries(bindLevels).map(([product, level]) => ({
      product,
      level,
    })),
    shareSeats,
    deviceLimit: bindDevices,
  };

  const priced = useMemo(() => {
    try {
      if (selection.items.length === 0) return null;
      return computePurchase(catalog, selection);
    } catch {
      return null;
    }
  }, [catalog, selection]);

  function toggleBindProduct(product: string) {
    setBindLevels((prev) => {
      if (product in prev) {
        const next = { ...prev };
        delete next[product];
        return next;
      }
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

  return (
    <div className="account-catalog" data-testid="account-catalog-purchase">
      <div className="account-catalog-body">
        <div className="account-catalog-config">
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
      </div>

      <div className="account-catalog-summary">
        <div className="account-catalog-summary__price">
          <span>{c.totalLabel}</span>
          <strong data-testid="catalog-total">
            {priced ? formatPriceCents(priced.priceCents) : "—"}
          </strong>
          <em>{fmt(c.perCycle, { n: catalog.durationDays })}</em>
        </div>
        {!priced && <p className="account-catalog-summary__hint">{c.emptyBindLevels}</p>}
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
        title={c.dialogTitleBind}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
}

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
        -
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
