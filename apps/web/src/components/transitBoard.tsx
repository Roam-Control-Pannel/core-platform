/**
 * transitBoard — shared primitives for the Northern Ireland departure board, used by both the
 * compact home/Explore widget (NearbyDepartures) and the expanded stop panel (StopBoardPanel).
 *
 * Everything visual about a board row lives here exactly once — the route roundel, the
 * town-stripped destination, the countdown + LIVE/TIMETABLED status — plus the mode-filter /
 * sort state (useBoardView) and the shared row/control styles. Keeping it in one module means the
 * two surfaces can never drift, and a later slice (accessibility tags) touches a single row.
 */
"use client";

import { useMemo, useState } from "react";
import type { useTranslations } from "next-intl";
import { Icon } from "@roam/design";
import { getFormatLocale } from "../lib/i18n/runtime";

export type Mode = "rail" | "bus" | "tram" | "ferry" | "other" | string;

export interface BoardDeparture {
  line: string;
  destination: string;
  mode: Mode;
  plannedTime: string;
  expectedTime: string | null;
  delayMin: number | null;
  realtime: boolean;
}

export interface Board {
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

type Translate = ReturnType<typeof useTranslations>;

/** The mode-filter groups the board offers as tabs (Glider = EFA's tram class in NI). */
export type FilterGroup = "all" | "bus" | "glider" | "rail" | "ferry";

/** Which filter tab a departure's mode belongs to. `other` rides under Bus (mostly coaches). */
export function filterGroupForMode(mode: Mode): Exclude<FilterGroup, "all"> {
  switch (mode) {
    case "rail":
      return "rail";
    case "tram":
      return "glider";
    case "ferry":
      return "ferry";
    default:
      return "bus";
  }
}

/** Walking minutes to a stop from its distance — ~80 m/min, floored at 1 so it never reads "0 min". */
export function walkMinutes(distanceM: number): number {
  return Math.max(1, Math.round(distanceM / 80));
}

/** Route-roundel colours per transit mode — solid signage chips, white text. */
export function modeBadge(mode: Mode): { bg: string; fg: string } {
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
export function cleanDestination(destination: string, placeName: string): string {
  const town = placeName.split(",")[0]?.trim();
  if (town && destination.toLowerCase().startsWith(`${town.toLowerCase()}, `)) {
    return destination.slice(town.length + 2);
  }
  return destination;
}

/**
 * Parse an EFA timestamp to epoch ms. EFA emits UTC ISO 8601; if a value lacks a timezone
 * designator we treat it as UTC (append `Z`) so "due in N min" isn't skewed by the viewer's
 * local offset (e.g. one hour during BST). Mirrors @roam/core/transit's parseEfaTime.
 */
export function parseEfaTime(iso: string): number {
  const hasTz = /[zZ]$/.test(iso) || /[+-]\d{2}:?\d{2}$/.test(iso);
  return Date.parse(hasTz ? iso : `${iso}Z`);
}

/**
 * Format a departure time relative to now: "Due" within a minute, "N min" under an hour, else a
 * local HH:MM. Uses the realtime estimate when present, otherwise the scheduled time.
 */
export function formatWhen(t: Translate, dep: BoardDeparture): string {
  const at = parseEfaTime(dep.expectedTime ?? dep.plannedTime);
  if (Number.isNaN(at)) return "";
  const mins = Math.round((at - Date.now()) / 60_000);
  if (mins <= 0) return t("due");
  if (mins < 60) return t("mins", { mins });
  return new Date(at).toLocaleTimeString(getFormatLocale(), { hour: "2-digit", minute: "2-digit" });
}

/**
 * Board view-state: the active mode filter + sort, the tabs actually worth showing, and the
 * resulting rows. A tab bar is pointless when everything is one mode, so `groups` is empty then.
 */
export function useBoardView(departures: BoardDeparture[]) {
  const [filter, setFilter] = useState<FilterGroup>("all");
  const [sort, setSort] = useState<"next" | "route">("next");

  const groups = useMemo<FilterGroup[]>(() => {
    const present = new Set(departures.map((d) => filterGroupForMode(d.mode)));
    const ordered = (["bus", "glider", "rail", "ferry"] as const).filter((g) => present.has(g));
    return ordered.length > 1 ? (["all", ...ordered] as FilterGroup[]) : [];
  }, [departures]);

  const rows = useMemo(() => {
    const filtered =
      filter === "all" ? departures : departures.filter((d) => filterGroupForMode(d.mode) === filter);
    if (sort === "next") return filtered;
    // "By route": cluster a line's departures together, earliest-departing line first. Unparseable
    // times sink to the end (Infinity) so sorting stays deterministic instead of NaN-unstable.
    const ms = (d: BoardDeparture): number => {
      const v = parseEfaTime(d.expectedTime ?? d.plannedTime);
      return Number.isNaN(v) ? Infinity : v;
    };
    const earliest = new Map<string, number>();
    filtered.forEach((d) => {
      const at = ms(d);
      const cur = earliest.get(d.line);
      if (cur === undefined || at < cur) earliest.set(d.line, at);
    });
    return [...filtered].sort(
      (a, b) =>
        (earliest.get(a.line) ?? Infinity) - (earliest.get(b.line) ?? Infinity) ||
        a.line.localeCompare(b.line) ||
        ms(a) - ms(b),
    );
  }, [departures, filter, sort]);

  return { filter, setFilter, sort, setSort, groups, rows };
}

/** The mode-filter tabs + sort toggle row. Renders nothing when neither control is worth showing. */
export function FilterControls({
  t,
  groups,
  filter,
  setFilter,
  sort,
  setSort,
  showSort,
}: {
  t: Translate;
  groups: FilterGroup[];
  filter: FilterGroup;
  setFilter: (g: FilterGroup) => void;
  sort: "next" | "route";
  setSort: (updater: (s: "next" | "route") => "next" | "route") => void;
  showSort: boolean;
}) {
  if (groups.length === 0 && !showSort) return null;
  return (
    <div style={controlRowStyle}>
      {groups.length > 0 ? (
        <div role="tablist" style={tabsStyle}>
          {groups.map((g) => (
            <button
              key={g}
              type="button"
              role="tab"
              aria-selected={filter === g}
              onClick={() => setFilter(g)}
              style={filter === g ? tabActiveStyle : tabStyle}
            >
              {t(`filter.${g}`)}
            </button>
          ))}
        </div>
      ) : (
        <span />
      )}
      {showSort ? (
        <button
          type="button"
          onClick={() => setSort((s) => (s === "next" ? "route" : "next"))}
          style={sortToggleStyle}
          aria-label={t(`sort.${sort === "next" ? "route" : "next"}`)}
        >
          {t(`sort.${sort}`)}
        </button>
      ) : null}
    </div>
  );
}

/** One departure row: route roundel · destination · countdown with a LIVE / TIMETABLED status. */
export function DepartureRow({
  d,
  placeName,
  t,
}: {
  d: BoardDeparture;
  placeName: string;
  t: Translate;
}) {
  const when = formatWhen(t, d);
  const due = when === t("due");
  const late = typeof d.delayMin === "number" && d.delayMin > 0;
  const early = typeof d.delayMin === "number" && d.delayMin < 0;
  const badge = modeBadge(d.mode);
  const statusTitle = late
    ? t("minLate", { mins: d.delayMin as number })
    : early
      ? t("minEarly", { mins: Math.abs(d.delayMin as number) })
      : d.realtime
        ? t("onTime")
        : t("timetabled");
  return (
    <li style={rowGridStyle}>
      <span style={{ ...badgeStyle, background: badge.bg, color: badge.fg }}>{d.line}</span>
      <span style={destStyle}>{cleanDestination(d.destination, placeName)}</span>
      <span style={timeCellStyle}>
        <span
          style={{
            fontWeight: 700,
            fontFamily: "var(--ui)",
            fontVariantNumeric: "tabular-nums",
            fontSize: 15,
            color: due || late ? "var(--crimson-700)" : "var(--ink)",
            whiteSpace: "nowrap",
          }}
        >
          {when}
        </span>
        <span title={statusTitle} style={statusLabelStyle}>
          {d.realtime ? (
            <span
              className="roam-live-pulse"
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: late ? "var(--crimson-700)" : "#1a9e57",
                flex: "0 0 auto",
              }}
            />
          ) : null}
          <span style={{ color: d.realtime ? (late ? "var(--crimson-700)" : "#1a7f4b") : "var(--faint)" }}>
            {d.realtime ? t("live") : t("timetabled")}
          </span>
        </span>
      </span>
    </li>
  );
}

/** The service-notices / disruptions block, harvested from the same EFA payload. Null when empty. */
export function Disruptions({
  alerts,
  t,
}: {
  alerts: Board["alerts"];
  t: Translate;
}) {
  if (!alerts || alerts.length === 0) return null;
  const urgent = alerts.some((a) => a.priority === "high" || a.priority === "veryHigh");
  return (
    <div
      style={{
        marginTop: "var(--space-3)",
        padding: "10px 12px",
        borderRadius: 12,
        display: "flex",
        gap: 10,
        background: urgent ? "var(--crimson-tint)" : "var(--paper-2)",
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
        {alerts.slice(0, 3).map((a, i) => (
          <div key={i} style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.45 }}>
            <span style={{ fontWeight: 600, color: "var(--ink)" }}>{a.title}</span>
            {a.content ? <span> — {a.content}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── shared styles ─────────────────────────────────────────────────────────────────────────── */

export const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: 2,
};

export const rowGridStyle: React.CSSProperties = {
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
  flexDirection: "column",
  alignItems: "flex-end",
  justifySelf: "end",
  whiteSpace: "nowrap",
};

const statusLabelStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontFamily: "var(--mono)",
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: ".08em",
  textTransform: "uppercase",
  marginTop: 2,
};

const controlRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  marginBottom: "var(--space-2)",
};

const tabsStyle: React.CSSProperties = {
  display: "inline-flex",
  gap: 2,
  background: "var(--paper-2)",
  borderRadius: 999,
  padding: 3,
  flexWrap: "wrap",
};

const tabBase: React.CSSProperties = {
  border: "none",
  cursor: "pointer",
  fontFamily: "var(--mono)",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: ".06em",
  textTransform: "uppercase",
  borderRadius: 999,
  padding: "4px 10px",
  lineHeight: 1,
};

const tabStyle: React.CSSProperties = { ...tabBase, background: "transparent", color: "var(--muted)" };

const tabActiveStyle: React.CSSProperties = {
  ...tabBase,
  background: "var(--card)",
  color: "var(--ink)",
  boxShadow: "0 1px 2px rgba(0,0,0,.06)",
};

const sortToggleStyle: React.CSSProperties = {
  flex: "0 0 auto",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontFamily: "var(--mono)",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: ".06em",
  textTransform: "uppercase",
  color: "var(--crimson-700)",
  padding: "4px 2px",
};

export const attributionStyle: React.CSSProperties = {
  marginTop: "var(--space-3)",
  paddingTop: "var(--space-2)",
  borderTop: "1px solid var(--line)",
  fontSize: 10.5,
  color: "var(--faint)",
};
