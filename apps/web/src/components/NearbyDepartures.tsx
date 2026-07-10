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
import { Icon, type IconName } from "@roam/design";
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
  attribution: string;
  cached: boolean;
}

/** The icon name for a transit mode. */
function modeIcon(mode: Mode): IconName {
  switch (mode) {
    case "rail":
      return "train";
    case "bus":
      return "bus";
    case "tram":
      return "tram";
    case "ferry":
      return "ferry";
    default:
      return "place";
  }
}

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

  // In NI, while we check for a live board, show a compact loading line.
  if (inNI && loading) {
    return (
      <div style={cardStyle}>
        <div style={{ ...rowStyle, color: "var(--ink-2)" }}>
          <Icon name="bus" size={16} />
          <span style={{ fontSize: 13 }}>{t("loading")}</span>
        </div>
      </div>
    );
  }

  // A real live board (in NI, with a nearby stop) → render departures.
  if (inNI && board && board.status === "ok" && board.stop) {
    const { stop, departures } = board;
    return (
      <div style={cardStyle}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: departures.length ? "var(--space-3)" : 0,
        }}
      >
        <div>
          <div
            className="t-h4"
            style={{ fontFamily: "var(--display)", color: "var(--ink)", lineHeight: 1.2 }}
          >
            {t("title")}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2 }}>
            {stop.name}
            {typeof stop.distanceM === "number" ? ` · ${t("mAway", { distance: stop.distanceM })}` : ""}
          </div>
        </div>
        <span
          aria-hidden
          title={t("realtimeWhereAvailable")}
          style={{ fontSize: 11, color: "var(--faint)", whiteSpace: "nowrap" }}
        >
          {placeName}
        </span>
      </div>

      {departures.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--muted)", paddingBottom: 2 }}>
          {t("noDepartures")}
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
          {departures.map((d, i) => {
            const when = formatWhen(t, d);
            const late = typeof d.delayMin === "number" && d.delayMin > 0;
            const early = typeof d.delayMin === "number" && d.delayMin < 0;
            return (
              <li key={`${d.line}-${d.plannedTime}-${i}`} style={rowStyle}>
                <span aria-hidden style={{ width: 20, display: "inline-flex", justifyContent: "center" }}>
                  <Icon name={modeIcon(d.mode)} size={16} />
                </span>
                <span
                  style={{
                    fontWeight: 700,
                    fontFamily: "var(--ui)",
                    color: "var(--ink)",
                    minWidth: 44,
                  }}
                >
                  {d.line}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--ink-2)",
                    fontSize: 13.5,
                  }}
                >
                  {d.destination}
                </span>
                <span
                  style={{
                    fontWeight: 700,
                    fontFamily: "var(--ui)",
                    color: late ? "var(--crimson-700)" : "var(--ink)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {when}
                </span>
                {d.realtime ? (
                  <span
                    title={
                      late
                        ? t("minLate", { mins: d.delayMin as number })
                        : early
                          ? t("minEarly", { mins: Math.abs(d.delayMin as number) })
                          : t("onTime")
                    }
                    aria-label={t("live")}
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: late ? "var(--crimson-700)" : "#1a9e57",
                      flex: "0 0 auto",
                    }}
                  />
                ) : (
                  <span style={{ width: 7, flex: "0 0 auto" }} />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div
        style={{
          marginTop: "var(--space-3)",
          paddingTop: "var(--space-2)",
          borderTop: "1px solid var(--line)",
          fontSize: 10.5,
          color: "var(--faint)",
        }}
      >
        {board.attribution || TRANSLINK_ATTRIBUTION}
      </div>
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

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 16,
  background: "var(--card)",
  padding: "var(--space-3) var(--space-4)",
  marginBottom: "var(--space-4)",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
};
