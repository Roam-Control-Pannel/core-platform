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
import { isWithinNI, TRANSLINK_ATTRIBUTION } from "../lib/transitRegion";

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

/** A small glyph per mode. Text-only so it needs no icon set. */
function modeGlyph(mode: Mode): string {
  switch (mode) {
    case "rail":
      return "🚆";
    case "bus":
      return "🚌";
    case "tram":
      return "🚊";
    case "ferry":
      return "⛴";
    default:
      return "•";
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
function formatWhen(dep: BoardDeparture): string {
  const t = parseEfaTime(dep.expectedTime ?? dep.plannedTime);
  if (Number.isNaN(t)) return "";
  const mins = Math.round((t - Date.now()) / 60_000);
  if (mins <= 0) return "Due";
  if (mins < 60) return `${mins} min`;
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
  const inRegion = isWithinNI(lat, lng);
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(false);
  // Generation guard: a rapid place change cancels the stale in-flight fetch (latest wins).
  const gen = useRef(0);

  useEffect(() => {
    if (!inRegion) {
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
  }, [inRegion, lat, lng]);

  // Not in NI → render nothing at all.
  if (!inRegion) return null;

  // Loading: a compact one-line skeleton (we already know the card is relevant here).
  if (loading) {
    return (
      <div style={cardStyle}>
        <div style={{ ...rowStyle, color: "var(--ink-2)" }}>
          <span aria-hidden>🚌</span>
          <span style={{ fontSize: 13 }}>Loading nearby departures…</span>
        </div>
      </div>
    );
  }

  // Only render a card when there's a real answer to show. Every other status (no stop nearby,
  // not configured, throttled, budget spent, error) hides silently — it's an enhancement.
  if (!board || board.status !== "ok" || !board.stop) return null;

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
            Nearby departures
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2 }}>
            {stop.name}
            {typeof stop.distanceM === "number" ? ` · ${stop.distanceM} m away` : ""}
          </div>
        </div>
        <span
          aria-hidden
          title="Realtime where available"
          style={{ fontSize: 11, color: "var(--faint)", whiteSpace: "nowrap" }}
        >
          {placeName}
        </span>
      </div>

      {departures.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--muted)", paddingBottom: 2 }}>
          No departures in the next while.
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
          {departures.map((d, i) => {
            const when = formatWhen(d);
            const late = typeof d.delayMin === "number" && d.delayMin > 0;
            const early = typeof d.delayMin === "number" && d.delayMin < 0;
            return (
              <li key={`${d.line}-${d.plannedTime}-${i}`} style={rowStyle}>
                <span aria-hidden style={{ width: 20, textAlign: "center" }}>
                  {modeGlyph(d.mode)}
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
                        ? `${d.delayMin} min late`
                        : early
                          ? `${Math.abs(d.delayMin as number)} min early`
                          : "On time (live)"
                    }
                    aria-label="Live"
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
