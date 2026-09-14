/**
 * FsaChip — a compact FSA food-hygiene rating chip for venue cards + grids (D4-b).
 *
 * The rating is decided SERVER-SIDE (venues.fsaRatings, via @roam/core/fsa) and handed to the host
 * grid as a batch; this component only renders the already-decided result, so a non-numeric status is
 * NEVER shown as a number (the legally-sensitive rule stays server-side, and the web never imports
 * core). The full badge + dates live on the venue page (FsaBadge); this is the at-a-glance card mark.
 *
 * The FSA's open-data licence requires an OGL attribution wherever a rating is shown — render
 * FsaAttributionLine ONCE per grid (a footer), not per chip, so a dense grid stays legible.
 */
"use client";

import type { CSSProperties } from "react";

/** The display-decided rating shape (the renderable subset — the batch never returns "none"). */
export type CardFsaRating =
  | { kind: "score"; score: 0 | 1 | 2 | 3 | 4 | 5 }
  | { kind: "awaiting" }
  | { kind: "exempt" };

export function FsaChip({ rating }: { rating: CardFsaRating }) {
  if (rating.kind === "score") {
    // Same semantic colours as the venue-page badge: green ≥3, amber 1–2, red 0.
    const bg = rating.score >= 3 ? "#0f8a3f" : rating.score >= 1 ? "#C77A00" : "#B4231F";
    return (
      <span role="img" aria-label={`Food Hygiene Rating: ${rating.score} out of 5`} style={{ ...chip, background: bg, color: "#fff" }}>
        <span style={tag}>FSA</span>
        <span style={{ fontWeight: 800 }}>{rating.score}</span>
      </span>
    );
  }
  const label = rating.kind === "awaiting" ? "Awaiting" : "Exempt";
  return (
    <span role="img" aria-label={`Food hygiene: ${label}`} style={{ ...chip, background: "var(--paper-2)", color: "var(--ink-2)" }}>
      <span style={tag}>FSA</span>
      <span style={{ fontWeight: 700 }}>{label}</span>
    </span>
  );
}

/** The Open Government Licence attribution — required once on any surface that shows FSA ratings. */
export function FsaAttributionLine({ style }: { style?: CSSProperties }) {
  return (
    <p style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.4, margin: 0, ...style }}>
      Contains public sector information licensed under the{" "}
      <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" target="_blank" rel="noopener noreferrer nofollow" style={link}>
        Open Government Licence v3.0
      </a>
      . Food hygiene ratings from the{" "}
      <a href="https://ratings.food.gov.uk/" target="_blank" rel="noopener noreferrer nofollow" style={link}>
        Food Standards Agency
      </a>
      .
    </p>
  );
}

const chip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 7px",
  borderRadius: 6,
  fontFamily: "var(--mono)",
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: ".02em",
  lineHeight: 1.4,
  whiteSpace: "nowrap",
};
const tag: CSSProperties = { fontSize: 8.5, fontWeight: 800, letterSpacing: ".08em", opacity: 0.85, textTransform: "uppercase" };
const link: CSSProperties = { color: "var(--muted)", textDecoration: "underline" };
