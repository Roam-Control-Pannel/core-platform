/**
 * StorefrontHome — the Food to Go home, shown instead of the Roam home when on the f2g channel.
 *
 * Menu of nearby vendors: a branded hero (channel name/tagline + palette from useChannel), the
 * same place control the Roam home uses (useCurrentPlace + PlaceSwitcher), and a grid of vendor
 * tiles fed by venues.inChannelNear — the non-truncating "f2g vendors nearest me" read from 2A.
 * Ships its states: loading skeletons, empty (the median experience in a new area), and results.
 */
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { useChannel } from "./ChannelProvider";
import { useCurrentPlace } from "../lib/currentPlace";
import { PlaceSwitcher } from "./PlaceSwitcher";
import { F2GVendorCard, type F2GVendor } from "./F2GVendorCard";

const FALLBACK_BRAND = "#E8562A";
const FALLBACK_ACCENT = "#1F9D55";

export function StorefrontHome() {
  const t = useTranslations("storefront");
  const trpc = useTrpc();
  const { channel } = useChannel();
  const { place, setPlace } = useCurrentPlace();
  const [vendors, setVendors] = useState<F2GVendor[] | null>(null);

  const brand = channel?.theme.brand ?? FALLBACK_BRAND;
  const accent = channel?.theme.accent ?? FALLBACK_ACCENT;
  const title = channel?.name ?? t("defaultTitle");
  const tagline = channel?.tagline ?? t("defaultTagline");

  useEffect(() => {
    let cancelled = false;
    setVendors(null);
    trpc.venues.inChannelNear
      .query({ channelKey: "f2g", lat: place.lat, lng: place.lng, pageSize: 24 })
      .then((r) => {
        if (!cancelled) setVendors(r.venues as F2GVendor[]);
      })
      .catch(() => {
        if (!cancelled) setVendors([]);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, place.lat, place.lng]);

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      {/* Branded hero */}
      <header
        style={{
          borderRadius: 20,
          padding: "var(--space-6) var(--space-5)",
          background: `linear-gradient(135deg, ${brand}, ${accent})`,
          color: "#fff",
          marginBottom: "var(--space-4)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span aria-hidden style={{ display: "grid", placeItems: "center", width: 40, height: 40, borderRadius: 12, background: "rgba(255,255,255,.2)" }}>
            <Icon name="bag" size={20} />
          </span>
          <h1 style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 28, letterSpacing: "-.02em", margin: 0 }}>
            {title}
          </h1>
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 15.5, opacity: 0.95, maxWidth: 520 }}>{tagline}</p>
      </header>

      {/* Place control */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "var(--space-4)", fontSize: 15, color: "var(--ink-2)" }}>
        <span style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 18, color: "var(--ink)" }}>
          {t("nearHeading", { place: place.name })}
        </span>
        <PlaceSwitcher value={place} onChange={setPlace} />
      </div>

      {/* Results */}
      {vendors === null ? (
        <Grid>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={{ borderRadius: 16, height: 220, background: "var(--paper-2)" }} aria-hidden />
          ))}
        </Grid>
      ) : vendors.length === 0 ? (
        <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)", maxWidth: 420, margin: "0 auto" }}>
          <div style={{ fontSize: 40, marginBottom: 8 }} aria-hidden>🥡</div>
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: 6 }}>{t("empty.title")}</div>
          <p style={{ color: "var(--muted)", lineHeight: 1.55, fontSize: 14 }}>{t("empty.body")}</p>
        </div>
      ) : (
        <Grid>
          {vendors.map((v) => (
            <F2GVendorCard key={v.id} vendor={v} accent={accent} />
          ))}
        </Grid>
      )}
    </main>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "var(--space-4)" }}>
      {children}
    </div>
  );
}
