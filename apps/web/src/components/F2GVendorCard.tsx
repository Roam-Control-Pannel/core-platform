/**
 * F2GVendorCard — a menu-forward vendor tile for the Food to Go storefront.
 *
 * Unlike the Roam VenueCard (social affordances, follow), this is a shopfront tile: cover, name,
 * a rating/type/distance meta line, and an "Order ahead" chip. Tapping it deep-links straight to
 * the vendor's menu (the Shop tab), because on the storefront the menu IS the point. Cover
 * resolution reuses the same lazy photoMediaUrl path VenueCard uses (keyless, per-mount URL).
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Icon, Rate } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { venuePath } from "../lib/routes";

export interface F2GVendor {
  id: string;
  name: string;
  category: string | null;
  primaryTypeLabel?: string | null;
  rating: number | null;
  ratingCount?: number | null;
  distanceM?: number;
  coverPhotoId?: string | null;
  businessStatus?: string | null;
}

function formatDistance(m?: number): string | null {
  if (m == null) return null;
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export function F2GVendorCard({ vendor, accent }: { vendor: F2GVendor; accent: string }) {
  const t = useTranslations("storefront");
  const trpc = useTrpc();
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const distance = formatDistance(vendor.distanceM);
  const typeLabel = vendor.primaryTypeLabel || vendor.category;

  useEffect(() => {
    if (!vendor.coverPhotoId) return;
    let cancelled = false;
    trpc.venues.photoMediaUrl
      .query({ photoId: vendor.coverPhotoId })
      .then((r) => {
        if (!cancelled && r?.url) setCoverUrl(r.url);
      })
      .catch(() => {
        /* keep the fallback tile */
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, vendor.coverPhotoId]);

  return (
    <Link
      href={`${venuePath(vendor.id)}?tab=shop`}
      style={{
        display: "block",
        textDecoration: "none",
        color: "inherit",
        borderRadius: 16,
        overflow: "hidden",
        border: "1px solid var(--line)",
        background: "var(--card)",
      }}
    >
      <div style={{ position: "relative", aspectRatio: "4 / 3", background: "var(--paper-2)" }}>
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived keyless media URL
          <img src={coverUrl} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        ) : (
          <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--faint)" }}>
            <Icon name="bag" size={28} />
          </span>
        )}
        <span
          style={{
            position: "absolute",
            left: 8,
            bottom: 8,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 9px",
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 700,
            color: "#fff",
            background: accent,
          }}
        >
          <Icon name="clock" size={11} strokeWidth={2.5} /> {t("orderAhead")}
        </span>
      </div>
      <div style={{ padding: "10px 12px 12px" }}>
        <div style={{ fontFamily: "var(--ui)", fontWeight: 600, fontSize: 15, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {vendor.name}
        </div>
        <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5, color: "var(--ink-2)" }}>
          {vendor.rating != null ? <Rate value={vendor.rating} /> : null}
          {typeLabel ? <span>{typeLabel}</span> : null}
          {distance ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--muted)" }}>
              <Icon name="locate" size={12} /> {distance}
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
