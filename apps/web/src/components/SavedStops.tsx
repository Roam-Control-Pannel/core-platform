/**
 * SavedStops — a Home-rail widget listing the user's saved Translink stops (Stage 5 · Slice E).
 *
 * Self-hiding: renders nothing when signed out, still loading, or the list is empty, so it only
 * appears once a person has actually starred a stop. Tapping a row opens that stop's full board
 * (StopBoardPanel, cold-opened by coordinate) — the same panel the departures widget uses.
 */
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@roam/design";
import { detectMapsPlatform, type MapsPlatform } from "../lib/directions";
import { useSavedStopsList, type SavedStop } from "./useSavedStops";
import { StopBoardPanel } from "./StopBoardPanel";

export function SavedStops({ hasSession }: { hasSession: boolean }) {
  const t = useTranslations("nearbyDepartures");
  const { stops } = useSavedStopsList();
  const [open, setOpen] = useState<SavedStop | null>(null);
  const [platform] = useState<MapsPlatform>(() =>
    typeof navigator !== "undefined"
      ? detectMapsPlatform(navigator.userAgent, navigator.maxTouchPoints, navigator.platform)
      : "web",
  );

  // Self-hide until there's something to show.
  if (!hasSession || stops === null || stops.length === 0) return null;

  return (
    <div style={cardStyle}>
      <header style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "var(--space-3)" }}>
        <span aria-hidden style={iconChipStyle}>
          <Icon name="star" size={15} />
        </span>
        <div className="t-h4" style={{ fontFamily: "var(--display)", fontWeight: 600, color: "var(--ink)", lineHeight: 1.2 }}>
          {t("savedTitle")}
        </div>
      </header>

      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2 }}>
        {stops.map((s) => (
          <li key={s.stop_id}>
            <button type="button" onClick={() => setOpen(s)} style={rowStyle}>
              <Icon name="bus" size={15} aria-hidden style={{ color: "var(--ink-2)", flex: "0 0 auto" }} />
              <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink)", fontSize: 14 }}>
                {s.name}
              </span>
              <Icon name="chevronRight" size={16} aria-hidden style={{ color: "var(--faint)", flex: "0 0 auto" }} />
            </button>
          </li>
        ))}
      </ul>

      {open ? (
        <StopBoardPanel
          placeName={open.name}
          lat={open.lat}
          lng={open.lng}
          platform={platform}
          stopId={open.stop_id}
          stopName={open.name}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 16,
  background: "var(--card)",
  padding: "var(--space-4)",
  marginBottom: "var(--space-4)",
};

const iconChipStyle: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 26,
  height: 26,
  borderRadius: 9,
  background: "var(--crimson-tint)",
  color: "var(--crimson-700)",
  flex: "0 0 auto",
};

const rowStyle: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  boxSizing: "border-box",
  padding: "9px 0",
  borderTop: "1px solid var(--line)",
};
