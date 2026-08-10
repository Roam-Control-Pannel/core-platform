/**
 * VenueF2GPreview — a live preview of how a vendor's listing appears on the Food to Go storefront.
 *
 * Shown inside the Food to Go dashboard tab so a vendor can see, before going live, exactly what a
 * customer will: a collection summary (order-ahead vs collection, "usually ready in ~N min", a
 * paused badge) themed with the REAL f2g channel palette (fetched from channels.get, not guessed),
 * and the menu tiles (active products via market.listByVenue — the same read the public storefront
 * uses, so the preview can't drift from reality).
 */
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { formatPence } from "../lib/money";

interface PreviewProduct {
  id: string;
  kind: "product" | "service";
  title: string;
  description: string | null;
  pricePence: number;
  stock: number | null;
  photoUrl: string | null;
}

interface CollectionSummary {
  orderAhead: boolean;
  paused: boolean;
  prepTimeMins: number;
}

const F2G_FALLBACK = { brand: "#E8562A", accent: "#1F9D55" };

export function VenueF2GPreview({
  venueId,
  venueName,
  settings,
}: {
  venueId: string;
  venueName: string;
  settings: CollectionSummary;
}) {
  const t = useTranslations("venueOwnerEditor.foodToGo.preview");
  const trpc = useTrpc();
  const [products, setProducts] = useState<PreviewProduct[] | null>(null);
  const [theme, setTheme] = useState<{ brand: string; accent: string }>(F2G_FALLBACK);

  useEffect(() => {
    let cancelled = false;
    trpc.market.listByVenue
      .query({ venueId })
      .then((r) => {
        if (!cancelled) setProducts((r?.products ?? []) as PreviewProduct[]);
      })
      .catch(() => {
        if (!cancelled) setProducts([]);
      });
    trpc.channels.get
      .query({ key: "f2g" })
      .then((ch) => {
        if (cancelled || !ch) return;
        setTheme({
          brand: ch.theme.brand ?? F2G_FALLBACK.brand,
          accent: ch.theme.accent ?? F2G_FALLBACK.accent,
        });
      })
      .catch(() => {
        /* fall back to the seeded f2g palette */
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, venueId]);

  return (
    <div
      style={{
        borderRadius: 18,
        overflow: "hidden",
        border: "1px solid var(--line)",
        background: "var(--card)",
      }}
    >
      {/* Storefront header, in the f2g palette */}
      <div style={{ padding: "var(--space-4) var(--space-5)", background: theme.brand, color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            aria-hidden
            style={{
              display: "grid",
              placeItems: "center",
              width: 36,
              height: 36,
              borderRadius: 11,
              background: "rgba(255,255,255,.2)",
            }}
          >
            <Icon name="bag" size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 18, lineHeight: 1.1 }}>
              {venueName}
            </div>
            <div style={{ fontSize: 12.5, opacity: 0.9 }}>
              {settings.orderAhead ? t("orderAhead") : t("collectOnly")}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {settings.paused ? (
            <PreviewChip tone="warn">{t("paused")}</PreviewChip>
          ) : (
            <PreviewChip tone="accent" accent={theme.accent}>
              <Icon name="clock" size={12} strokeWidth={2.5} /> {t("readyIn", { mins: settings.prepTimeMins })}
            </PreviewChip>
          )}
        </div>
      </div>

      {/* Menu grid */}
      <div style={{ padding: "var(--space-4) var(--space-5)" }}>
        {products === null ? (
          <div style={{ height: 120, borderRadius: 14, background: "var(--paper-2)" }} aria-hidden />
        ) : products.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>{t("empty")}</p>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
              gap: "var(--space-3)",
            }}
          >
            {products.map((p) => (
              <PreviewTile key={p.id} product={p} accent={theme.accent} soldOutLabel={t("soldOut")} voucherLabel={t("voucher")} freeLabel={t("free")} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewTile({
  product,
  accent,
  soldOutLabel,
  voucherLabel,
  freeLabel,
}: {
  product: PreviewProduct;
  accent: string;
  soldOutLabel: string;
  voucherLabel: string;
  freeLabel: string;
}) {
  const soldOut = product.stock === 0;
  return (
    <div style={{ borderRadius: 14, border: "1px solid var(--line)", overflow: "hidden", background: "var(--card)" }}>
      <div style={{ aspectRatio: "1 / 1", background: "var(--paper-2)", position: "relative" }}>
        {product.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- public CDN URL, fixed square tile
          <img
            src={product.photoUrl}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", filter: soldOut ? "grayscale(1)" : undefined }}
          />
        ) : (
          <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--faint)" }}>
            <Icon name={product.kind === "service" ? "ticket" : "bag"} size={26} />
          </span>
        )}
        {soldOut ? (
          <span style={{ position: "absolute", top: 8, left: 8, ...tinyChip, background: "var(--ink)", color: "#fff" }}>
            {soldOutLabel}
          </span>
        ) : product.kind === "service" ? (
          <span style={{ position: "absolute", top: 8, left: 8, ...tinyChip, background: accent, color: "#fff" }}>
            {voucherLabel}
          </span>
        ) : null}
      </div>
      <div style={{ padding: "10px 12px" }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {product.title}
        </div>
        <div style={{ marginTop: 2, fontSize: 13, fontWeight: 700, color: "var(--ink-hi)" }}>
          {product.pricePence > 0 ? formatPence(product.pricePence) : freeLabel}
        </div>
      </div>
    </div>
  );
}

function PreviewChip({
  children,
  tone,
  accent,
}: {
  children: React.ReactNode;
  tone: "accent" | "warn";
  accent?: string;
}) {
  const bg = tone === "warn" ? "rgba(0,0,0,.28)" : accent ?? "rgba(255,255,255,.25)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "5px 11px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        color: "#fff",
        background: bg,
      }}
    >
      {children}
    </span>
  );
}

const tinyChip: React.CSSProperties = {
  padding: "3px 8px",
  borderRadius: 999,
  fontFamily: "var(--mono)",
  fontSize: 9.5,
  letterSpacing: ".04em",
  textTransform: "uppercase",
  fontWeight: 700,
};
