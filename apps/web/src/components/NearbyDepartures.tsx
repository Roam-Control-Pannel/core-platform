/**
 * NearbyDepartures — the Northern Ireland live-transit card (Translink Opendata, Slice 1).
 *
 * Shown on Explore under a place that sits inside NI. It asks the server-side hop
 * (POST /api/transit/nearby) for the live departure board of the nearest Translink stop and
 * renders it: the stop, up to a handful of upcoming services with realtime "due in" times, and
 * the licence-required attribution. Everything is best-effort and self-hiding — outside NI, or
 * when the feature isn't configured / has nothing to show, the component renders nothing so it
 * never clutters a place that has no transit answer.
 *
 * The NI check runs CLIENT-SIDE first (lib/transitRegion mirrors core's geofence) so we don't
 * even POST for an obviously-out-of-region place; the server geofences again as the real gate.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@roam/design";
import { isWithinNI, isWithinIreland, TRANSLINK_ATTRIBUTION } from "../lib/transitRegion";
import { getFormatLocale } from "../lib/i18n/runtime";

type Mode = "rail" | "bus" | "tram" | "ferry" | "other" | string;

interface BoardDeparture {
  line: string;
  destination: string;
  mode: Mode;
  plannedTime: string;
  expectedTime: string | null;
  delayMin: number | null;
  realtime: boolean;
}

interface Board {
  status:
    | "ok"
    | "no-stop"
    | "outside-region"
    | "unconfigured"
    | "throttled"
    | "budget-exhausted"
    | "error";
  stop: { id: string; name: string; lat: number; lng: number; distanceM: number | null } | null;
  departures: BoardDeparture[];
  alerts?: { title: string; content: string | null; priority: string | null; url: string | null }[];
  attribution: string;
  cached: boolean;
}

/** Route-roundel colours per transit mode — solid signage chips, white text. */
function modeBadge(mode: Mode): { bg: string; fg: string } {
  switch (mode) {
    case "rail":
      return { bg: "var(--crimson-700)", fg: "#fff" };
    case "tram":
    case "ferry":
      return { bg: "var(--ink-2)", fg: "#fff" };
    default: // bus / other
      return { bg: "var(--ink)", fg: "#fff" };
  }
}

/**
 * Drop a leading locality that just repeats where the reader already is — on a Belfast board,
 * "Belfast, Eastside Park and Ride" becomes "Eastside Park and Ride". Only strips when the
 * destination's first segment matches the place's town, so cross-town destinations keep it.
 */
function cleanDestination(destination: string, placeName: string): string {
  const town = placeName.split(",")[0]?.trim();
  if (town && destination.toLowerCase().startsWith(`${town.toLowerCase()}, `)) {
    return destination.slice(town.length + 2);
  }
  return destination;
}

/** How many departures the compact board shows before collapsing to a "+N more" line. */
const MAX_ROWS = 6;

/**
 * Parse an EFA timestamp to epoch ms. EFA emits UTC ISO 8601; if a value lacks a timezone
 * designator we treat it as UTC (append `Z`) so "due in N min" isn't skewed by the viewer's
 * local offset (e.g. one hour during BST). Mirrors @roam/core/transit's parseEfaTime.
 */
function parseEfaTime(iso: string): number {
  const hasTz = /[zZ]$/.test(iso) || /[+-]\d{2}:?\d{2}$/.test(iso);
  return Date.parse(hasTz ? iso : `${iso}Z`);
}

/**
 * Format a departure time relative to now: "Due" within a minute, "N min" under an hour, else a
 * local HH:MM. Uses the realtime estimate when present, otherwise the scheduled time.
 */
function formatWhen(t: ReturnType<typeof useTranslations>, dep: BoardDeparture): string {
  const at = parseEfaTime(dep.expectedTime ?? dep.plannedTime);
  if (Number.isNaN(at)) return "";
  const mins = Math.round((at - Date.now()) / 60_000);
  if (mins <= 0) return t("due");
  if (mins < 60) return t("mins", { mins });
  return new Date(at).toLocaleTimeString(getFormatLocale(), { hour: "2-digit", minute: "2-digit" });
}

export function NearbyDepartures({
  lat,
  lng,
  placeName,
}: {
  lat: number;
  lng: number;
  placeName: string;
}) {
  const t = useTranslations("nearbyDepartures");
  // Live departures exist only in NI; the "coming soon" placeholder reaches across the whole
  // island of Ireland (Translink is Ireland-only, so nothing shows outside it).
  const inNI = isWithinNI(lat, lng);
  const inIreland = isWithinIreland(lat, lng);
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(false);
  // Generation guard: a rapid place change cancels the stale in-flight fetch (latest wins).
  const gen = useRef(0);

  useEffect(() => {
    if (!inNI) {
      // Outside NI there's no live board to fetch — the placeholder handles the rest of Ireland.
      setBoard(null);
      return;
    }
    const mine = ++gen.current;
    setLoading(true);
    setBoard(null);
    void (async () => {
      try {
        const res = await fetch("/api/transit/nearby", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat, lng }),
        });
        const data = (await res.json()) as Board;
        if (gen.current !== mine) return;
        setBoard(data);
      } catch {
        if (gen.current !== mine) return;
        setBoard(null); // silent: transit is an enhancement, not core to the page
      } finally {
        if (gen.current === mine) setLoading(false);
      }
    })();
  }, [inNI, lat, lng]);

  // Outside the island of Ireland → nothing at all (Translink is Ireland-only).
  if (!inIreland) return null;

  // In NI, while we check for a live board, show the header with skeleton rows.
  if (inNI && loading) {
    return (
      <div style={cardStyle}>
        <BoardHeader title={t("title")} subline={t("loading")} />
        <ul style={listStyle}>
          {[0, 1, 2].map((i) => (
            <li key={i} style={{ ...rowGridStyle, opacity: 1 - i * 0.28 }}>
              <span style={{ ...badgeStyle, background: "var(--paper-2)", color: "transparent" }}>••</span>
              <span style={{ height: 12, borderRadius: 6, background: "var(--paper-2)" }} />
              <span style={{ height: 12, width: 42, borderRadius: 6, background: "var(--paper-2)", justifySelf: "end" }} />
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // A real live board (in NI, with a nearby stop) → render departures.
  if (inNI && board && board.status === "ok" && board.stop) {
    const { stop, departures } = board;
    const anyLive = departures.some((d) => d.realtime);
    const shown = departures.slice(0, MAX_ROWS);
    const hidden = departures.length - shown.length;
    const subline =
      stop.name +
      (typeof stop.distanceM === "number" ? ` · ${t("mAway", { distance: stop.distanceM })}` : "");
    return (
      <div style={cardStyle}>
        <BoardHeader title={t("title")} subline={subline} {...(anyLive ? { live: t("live") } : {})} />

        {departures.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--muted)", padding: "var(--space-2) 0 2px" }}>
            {t("noDepartures")}
          </div>
        ) : (
          <ul style={listStyle}>
            {shown.map((d, i) => {
              const when = formatWhen(t, d);
              const due = when === t("due");
              const late = typeof d.delayMin === "number" && d.delayMin > 0;
              const early = typeof d.delayMin === "number" && d.delayMin < 0;
              const badge = modeBadge(d.mode);
              const dotTitle = late
                ? t("minLate", { mins: d.delayMin as number })
                : early
                  ? t("minEarly", { mins: Math.abs(d.delayMin as number) })
                  : t("onTime");
              return (
                <li key={`${d.line}-${d.plannedTime}-${i}`} style={rowGridStyle}>
                  <span style={{ ...badgeStyle, background: badge.bg, color: badge.fg }}>{d.line}</span>
                  <span style={destStyle}>{cleanDestination(d.destination, placeName)}</span>
                  <span style={timeCellStyle}>
                    {d.realtime ? (
                      <span
                        className="roam-live-pulse"
                        title={dotTitle}
                        aria-label={t("live")}
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: late ? "var(--crimson-700)" : "#1a9e57",
                          flex: "0 0 auto",
                        }}
                      />
                    ) : null}
                    <span
                      style={{
                        fontWeight: 700,
                        fontFamily: "var(--ui)",
                        fontVariantNumeric: "tabular-nums",
                        color: due || late ? "var(--crimson-700)" : "var(--ink)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {when}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {hidden > 0 ? (
          <div style={{ fontSize: 12, color: "var(--faint)", marginTop: "var(--space-2)", paddingLeft: 2 }}>
            {t("more", { count: hidden })}
          </div>
        ) : null}

        {board.alerts && board.alerts.length > 0 ? (
          <div
            style={{
              marginTop: "var(--space-3)",
              padding: "10px 12px",
              borderRadius: 12,
              display: "flex",
              gap: 10,
              background: board.alerts.some((a) => a.priority === "high" || a.priority === "veryHigh")
                ? "var(--crimson-tint)"
                : "var(--paper-2)",
            }}
          >
            <Icon
              name="megaphone"
              size={15}
              aria-hidden
              style={{ color: "var(--crimson-700)", flex: "0 0 auto", marginTop: 1 }}
            />
            <div style={{ minWidth: 0 }}>
              <div className="t-mono-label" style={{ fontSize: 10, color: "var(--muted)", marginBottom: 3 }}>
                {t("disruptions")}
              </div>
              {board.alerts.slice(0, 3).map((a, i) => (
                <div key={i} style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.45 }}>
                  <span style={{ fontWeight: 600, color: "var(--ink)" }}>{a.title}</span>
                  {a.content ? <span> — {a.content}</span> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div style={attributionStyle}>{board.attribution || TRANSLINK_ATTRIBUTION}</div>
      </div>
    );
  }

  // Anywhere on the island of Ireland without a live board → the "coming soon" placeholder.
  return <TransitComingSoon placeName={placeName} />;
}

/**
 * TransitComingSoon — the geographical teaser shown across the island of Ireland while live
 * departures aren't available (pending Translink go-live, or outside NI where there's no live
 * board). Deliberately Ireland-only: Translink is an Ireland operator, so this never appears
 * elsewhere. Once NI departures are live, NI places show the real board and this remains the
 * placeholder for the rest of the island.
 */
function TransitComingSoon({ placeName }: { placeName: string }) {
  const t = useTranslations("nearbyDepartures");
  return (
    <div
      style={{
        ...cardStyle,
        borderStyle: "dashed",
        background: "var(--paper-2)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <Icon name="train" size={18} />
        <div
          className="t-h4"
          style={{ fontFamily: "var(--display)", color: "var(--ink)", lineHeight: 1.2, flex: 1 }}
        >
          {t("comingSoon.title")}
        </div>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 9.5,
            letterSpacing: ".06em",
            textTransform: "uppercase",
            color: "var(--muted)",
            border: "1px solid var(--line-2)",
            borderRadius: 999,
            padding: "2px 8px",
          }}
        >
          {t("comingSoon.badge")}
        </span>
      </div>
      <p style={{ color: "var(--ink-2)", fontSize: 13, lineHeight: 1.5, margin: 0 }}>
        {t("comingSoon.body", { place: placeName })}
      </p>
      <div
        style={{
          marginTop: "var(--space-3)",
          paddingTop: "var(--space-2)",
          borderTop: "1px solid var(--line)",
          fontSize: 10.5,
          color: "var(--faint)",
        }}
      >
        {TRANSLINK_ATTRIBUTION}
      </div>
    </div>
  );
}

/**
 * BoardHeader — the shared crest for the transit card: a crimson bus icon-chip, the title, a
 * stop·distance subline, and an optional right-aligned LIVE pulse pill when the board carries
 * realtime data. Matches the icon-chip + display-title language of the home widgets around it.
 */
function BoardHeader({ title, subline, live }: { title: string; subline: string; live?: string }) {
  return (
    <header style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: "var(--space-3)" }}>
      <span aria-hidden style={iconChipStyle}>
        <Icon name="bus" size={15} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          className="t-h4"
          style={{ fontFamily: "var(--display)", fontWeight: 600, color: "var(--ink)", lineHeight: 1.2 }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--ink-2)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {subline}
        </div>
      </div>
      {live ? (
        <span style={livePillStyle}>
          <span
            className="roam-live-pulse"
            style={{ width: 6, height: 6, borderRadius: "50%", background: "#1a9e57", flex: "0 0 auto" }}
          />
          {live}
        </span>
      ) : null}
    </header>
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

const livePillStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  flex: "0 0 auto",
  fontFamily: "var(--mono)",
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: ".1em",
  textTransform: "uppercase",
  color: "var(--ink-2)",
  border: "1px solid var(--line-2)",
  borderRadius: 999,
  padding: "3px 9px 3px 7px",
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: 2,
};

const rowGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 12,
  padding: "7px 0",
  borderTop: "1px solid var(--line)",
};

const badgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 46,
  height: 24,
  padding: "0 8px",
  borderRadius: 7,
  fontFamily: "var(--ui)",
  fontWeight: 700,
  fontSize: 14,
  letterSpacing: ".01em",
  flex: "0 0 auto",
};

const destStyle: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--ink-2)",
  fontSize: 13.5,
};

const timeCellStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  justifySelf: "end",
  whiteSpace: "nowrap",
};

const attributionStyle: React.CSSProperties = {
  marginTop: "var(--space-3)",
  paddingTop: "var(--space-2)",
  borderTop: "1px solid var(--line)",
  fontSize: 10.5,
  color: "var(--faint)",
};
