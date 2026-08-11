/**
 * F2GVendorCard — a vendor tile on the NI Food to Go storefront. Co-branded: a category tag on the
 * cover, the vendor name + rating, and the Association-yellow "READY ~N MIN" pill with distance (in
 * miles, NI-style). Tapping deep-links to the vendor's menu (the Shop tab).
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { venuePath } from "../lib/routes";
import { STOREFRONT, milesFromMetres } from "../lib/storefront";

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
  prepMins?: number;
}

export function F2GVendorCard({ vendor }: { vendor: F2GVendor }) {
  const t = useTranslations("storefront");
  const trpc = useTrpc();
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const distance = milesFromMetres(vendor.distanceM);
  const tag = (vendor.primaryTypeLabel || vendor.category || "").trim();
  const ready = vendor.prepMins ?? 15;

  useEffect(() => {
    if (!vendor.coverPhotoId) return;
    let cancelled = false;
    trpc.venues.photoMediaUrl
      .query({ photoId: vendor.coverPhotoId })
      .then((r) => {
        if (!cancelled && r?.url) setCoverUrl(r.url);
      })
      .catch(() => {});
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
        borderRadius: 14,
        overflow: "hidden",
        border: "1px solid var(--line)",
        background: "var(--card)",
      }}
    >
      <div style={{ position: "relative", aspectRatio: "16 / 10", background: STOREFRONT.navyDeep }}>
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived keyless media URL
          <img src={coverUrl} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        ) : (
          <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "rgba(255,255,255,.5)" }}>
            <Icon name="bag" size={26} />
          </span>
        )}
        {tag ? (
          <span
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              padding: "5px 10px",
              background: STOREFRONT.navy,
              color: STOREFRONT.onNavy,
              fontFamily: "var(--mono)",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: ".05em",
              textTransform: "uppercase",
              borderBottomRightRadius: 10,
            }}
          >
            {tag}
          </span>
        ) : null}
      </div>

      <div style={{ padding: "10px 12px 12px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 15.5, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {vendor.name}
          </span>
          {vendor.rating != null ? (
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink-2)", flexShrink: 0 }}>{vendor.rating.toFixed(1)}</span>
          ) : null}
        </div>
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "3px 9px",
              borderRadius: 6,
              background: STOREFRONT.yellow,
              color: STOREFRONT.yellowInk,
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: ".03em",
              textTransform: "uppercase",
            }}
          >
            {t("readyMin", { mins: ready })}
          </span>
          {distance ? <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{distance}</span> : null}
        </div>
      </div>
    </Link>
  );
}
