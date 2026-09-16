/**
 * FsaBadge — the FSA food-hygiene rating on a venue page (C1-b; official artwork per decision #6).
 *
 * Self-contained, like the other venue panels: it fetches `venues.fsaRating`, which resolves the
 * rating SERVER-SIDE via @roam/core/fsa (so the legally-sensitive "never show a status as 0" rule
 * lives in exactly one place and the web bundle never imports core). This component only renders the
 * already-decided result:
 *   - score / awaiting / exempt with an official badge we ship → the FSA's own sticker (unaltered
 *     artwork from public/fsa/, chosen by the FSA rating key the server already validated);
 *   - the same without shipped artwork (or if the file fails to load) → the in-house mark, so the
 *     rating is never lost and a broken image never shows;
 *   - none / no match / not-yet-configured → renders nothing.
 *
 * The FSA's open-data terms require the RatingDate and an Open Government Licence attribution wherever
 * the rating is shown — both are rendered here, with a link to the establishment's FSA page. The
 * sticker prints its own descriptor ("Very good"), so the text beside it carries the dates; the
 * accessible name carries the descriptor for screen readers either way.
 */
"use client";

import { useEffect, useState } from "react";
import { useTrpc } from "./TrpcProvider";
import { fsaBadgeAsset } from "../lib/fsaBadges";
import styles from "./FsaBadge.module.css";

type DisplayableRating =
  | { kind: "score"; score: 0 | 1 | 2 | 3 | 4 | 5 }
  | { kind: "awaiting" }
  | { kind: "exempt" }
  | { kind: "none" };

interface FsaRating {
  rating: DisplayableRating;
  /** Official artwork: asset id = the FSA rating key (server-validated against what we ship). */
  badge: { assetId: string; alt: string } | null;
  ratingValue: string;
  ratingDate: string | null;
  syncedAt: string | null;
  localAuthority: string | null;
  fhrsid: string;
  detailUrl: string;
  attribution: { text: string; licenceUrl: string; source: string; sourceUrl: string };
}

const RATING_WORD: Record<number, string> = {
  0: "Urgent improvement necessary",
  1: "Major improvement necessary",
  2: "Improvement necessary",
  3: "Generally satisfactory",
  4: "Good",
  5: "Very good",
};

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function FsaBadge({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const [data, setData] = useState<FsaRating | null | undefined>(undefined);
  // Set when the official file fails to load (missing, blocked, corrupt) — the in-house mark takes over.
  const [artworkFailed, setArtworkFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setArtworkFailed(false);
    const q = trpc.venues.fsaRating as unknown as {
      query: (i: { venueId: string }) => Promise<FsaRating | null>;
    };
    q.query({ venueId })
      .then((r) => { if (!cancelled) setData(r); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [trpc, venueId]);

  // Nothing to show: no match, an unrenderable value, or the corpus isn't live yet.
  if (!data || data.rating.kind === "none") return null;

  const rated = fmtDate(data.ratingDate);
  const checked = fmtDate(data.syncedAt);
  const asset = artworkFailed ? null : fsaBadgeAsset(data.badge?.assetId);
  const headline =
    data.rating.kind === "score"
      ? RATING_WORD[data.rating.score]
      : data.rating.kind === "awaiting"
        ? "Rating awaited"
        : "Exempt from rating";

  return (
    <section aria-label="Food hygiene rating" style={{ display: "grid", gap: "var(--space-2)" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>
        Food hygiene rating
      </div>

      {asset && data.badge ? (
        // The official sticker. Unaltered FSA artwork on its own plate; the descriptor is IN the
        // artwork, so the text column carries the dates only (the alt carries the words for AT).
        <div className={styles.official}>
          {/* eslint-disable-next-line @next/next/no-img-element -- static, self-hosted official artwork; next/image adds nothing */}
          <img
            src={asset.src}
            alt={data.badge.alt}
            width={asset.width}
            height={asset.height}
            className={styles.sticker}
            decoding="async"
            loading="lazy" // ~300 KB official JPEG, below the hero; the width/height attrs reserve its box
            onError={() => setArtworkFailed(true)}
          />
          <div className={styles.meta}>
            <div className={styles.dates}>
              {rated ? `Rated ${rated}` : "Rating date unavailable"}
              {checked ? ` · checked ${checked}` : ""}
            </div>
            {data.localAuthority ? <div className={styles.council}>{data.localAuthority}</div> : null}
          </div>
        </div>
      ) : (
        // In-house mark — the pre-artwork rendering, kept verbatim as the fallback.
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", border: "1px solid var(--line)", borderRadius: 12, padding: "var(--space-3)", background: "var(--paper)" }}>
          {data.rating.kind === "score" ? (
            <ScoreMark score={data.rating.score} alt={data.badge?.alt ?? `Food Hygiene Rating: ${data.rating.score} out of 5`} />
          ) : (
            <StatusMark label={data.rating.kind === "awaiting" ? "Awaiting inspection" : "Exempt"} />
          )}
          <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>{headline}</div>
            <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
              {rated ? `Rated ${rated}` : "Rating date unavailable"}
              {checked ? ` · checked ${checked}` : ""}
            </div>
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.4 }}>
        {data.attribution.text}{" "}
        <a href={data.attribution.licenceUrl} target="_blank" rel="noopener noreferrer nofollow" style={{ color: "var(--muted)", textDecoration: "underline" }}>
          OGL v3.0
        </a>{" · "}
        <a href={data.detailUrl} target="_blank" rel="noopener noreferrer nofollow" style={{ color: "var(--muted)", textDecoration: "underline" }}>
          View on the FSA
        </a>
      </div>
    </section>
  );
}

/** The 0–5 score as the in-house mark: green when ≥3, amber at 1–2, red at 0. */
function ScoreMark({ score, alt }: { score: 0 | 1 | 2 | 3 | 4 | 5; alt: string }) {
  const bg = score >= 3 ? "#0f8a3f" : score >= 1 ? "#C77A00" : "#B4231F";
  return (
    <div
      role="img"
      aria-label={alt}
      style={{ flexShrink: 0, width: 56, height: 56, borderRadius: 10, background: bg, color: "#fff", display: "grid", placeItems: "center", boxShadow: "inset 0 0 0 2px rgba(255,255,255,.25)" }}
    >
      <div style={{ display: "grid", placeItems: "center", lineHeight: 1 }}>
        <span style={{ fontSize: 26, fontWeight: 800 }}>{score}</span>
        <span style={{ fontSize: 8, letterSpacing: ".04em", opacity: 0.9 }}>/ 5</span>
      </div>
    </div>
  );
}

function StatusMark({ label }: { label: string }) {
  return (
    <div
      role="img"
      aria-label={`Food hygiene: ${label}`}
      style={{ flexShrink: 0, minWidth: 56, height: 56, padding: "0 10px", borderRadius: 10, background: "var(--ink-2)", color: "#fff", display: "grid", placeItems: "center", textAlign: "center", fontSize: 11, fontWeight: 700 }}
    >
      {label}
    </div>
  );
}
