/**
 * FoundingBanner — the "be one of the first here" invitation, shown on Explore's landing when a
 * town's COMMUNITY is still cold, regardless of how full its venue directory is.
 *
 * WHY THIS EXISTS: venue supply self-seeds from Google the moment anyone looks, so the venue grid
 * is rarely empty for long — which means Explore's no-venues empty state (the old founding
 * invitation) almost never fires where it's actually needed. The thing that stays genuinely empty
 * in a new place is HUMAN contribution: the Forum and the marketplace. This banner reads that
 * directly — the locality's founding-Forum count + its live-listing count — and, while both are
 * near zero, invites the visitor to start things off. It sits ABOVE a full grid, not inside the
 * empty state, so a town with businesses-but-no-community still gets the nudge.
 *
 * Cheap + non-blocking: two tiny public head-count reads, keyed off the place NAME (the API owns
 * the locality identity — Forum by slug, marketplace by display-name match). A failed pulse just
 * hides the banner. Dismissal is per-town (localStorage keyed by a locality slug), so dismissing
 * one town never suppresses the invitation in the next, and each town's invite is offered once.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import type { Place } from "./PlaceSwitcher";

// Combined Forum + marketplace contributions below this = "early" (still worth a pioneer nudge).
const FOUNDING_THRESHOLD = 3;
const DISMISS_PREFIX = "roam:founding-dismissed:";

/** Stable per-town key for the dismissal record. Mirrors the API's locality slugging (lowercase,
 *  strip accents, non-alphanumerics → hyphens) so "St Andrews" and "st-andrews" share one record. */
function localitySlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function FoundingBanner({ place }: { place: Place }) {
  const t = useTranslations("explore");
  const trpc = useTrpc();
  const [early, setEarly] = useState(false);
  // Start hidden until we've read local storage + the pulse, so nothing flashes on first paint.
  const [dismissed, setDismissed] = useState(true);
  const slug = localitySlug(place.name);

  useEffect(() => {
    let cancelled = false;
    setEarly(false);

    let isDismissed = false;
    try {
      isDismissed = !!slug && localStorage.getItem(DISMISS_PREFIX + slug) === "1";
    } catch {
      /* private mode — treat as not dismissed */
    }
    setDismissed(isDismissed);
    if (isDismissed || !place.name.trim()) return;

    const forumQ = trpc.townHall.foundingStats as unknown as {
      query: (i: { localityName: string }) => Promise<{ contributors: number }>;
    };
    const listingsQ = trpc.listings.localCount as unknown as {
      query: (i: { localityName: string }) => Promise<{ count: number }>;
    };
    Promise.all([
      forumQ.query({ localityName: place.name }),
      listingsQ.query({ localityName: place.name }),
    ])
      .then(([forum, market]) => {
        if (cancelled) return;
        const total = (forum?.contributors ?? 0) + (market?.count ?? 0);
        setEarly(total < FOUNDING_THRESHOLD);
      })
      .catch(() => {
        /* a failed pulse just leaves the banner hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, place.name, slug]);

  const dismiss = useCallback(() => {
    try {
      if (slug) localStorage.setItem(DISMISS_PREFIX + slug, "1");
    } catch {
      /* private mode — dismissal just won't persist */
    }
    setDismissed(true);
  }, [slug]);

  if (dismissed || !early) return null;

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "flex-start",
        gap: "var(--space-3)",
        padding: "var(--space-4)",
        marginBottom: "var(--space-4)",
        borderRadius: 16,
        border: "1px solid var(--crimson-200, var(--line))",
        background: "var(--crimson-tint)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 40,
          height: 40,
          flexShrink: 0,
          borderRadius: 12,
          background: "var(--card)",
          color: "var(--crimson-700)",
          display: "grid",
          placeItems: "center",
        }}
      >
        <Icon name="star" size={20} />
      </span>

      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="t-h3" style={{ fontFamily: "var(--display)", fontSize: 18, lineHeight: 1.25 }}>
          {t("founding.title", { place: place.name })}
        </div>
        <p style={{ color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.45, margin: "4px 0 0" }}>
          {t("founding.body", { place: place.name })}
        </p>
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-3)" }}>
          <Link href="/town-hall" style={ctaPrimary}>
            <Icon name="landmark" size={15} /> {t("founding.forum")}
          </Link>
          <Link href="/market" style={ctaSecondary}>
            <Icon name="shop" size={15} /> {t("founding.sell")}
          </Link>
        </div>
      </div>

      <button
        type="button"
        onClick={dismiss}
        aria-label={t("founding.dismiss")}
        style={{
          all: "unset",
          cursor: "pointer",
          flexShrink: 0,
          padding: 6,
          borderRadius: 8,
          color: "var(--muted)",
          display: "grid",
          placeItems: "center",
        }}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

const ctaPrimary: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "9px 16px",
  borderRadius: 999,
  background: "var(--crimson)",
  color: "#fff",
  fontWeight: 600,
  fontSize: 14,
  textDecoration: "none",
};
const ctaSecondary: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "9px 16px",
  borderRadius: 999,
  background: "var(--card)",
  color: "var(--ink)",
  border: "1px solid var(--line)",
  fontWeight: 600,
  fontSize: 14,
  textDecoration: "none",
};
