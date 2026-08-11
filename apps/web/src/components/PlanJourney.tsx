/**
 * PlanJourney — the Northern Ireland journey planner (Translink Trip-Request, Slice 2).
 *
 * A collapsible "Plan a journey" panel. From/To are name-autocompletes backed by the server-side
 * hop POST /api/transit/stops (Stop-Finder); "Find journeys" calls POST /api/transit/plan
 * (Trip-Request) and renders the ranked results — each with legs, interchanges, realtime times and
 * the licence-required attribution. When mounted under a place, the destination is pre-filled with
 * that place's coordinate (EFA plans from/to a raw coord), so it opens as "journey to {place}".
 *
 * Best-effort + self-hiding like NearbyDepartures: the caller only renders it inside NI. Every API
 * outcome is a `status` string, so a failure degrades to an inline message, never a thrown error.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@roam/design";
import { getFormatLocale } from "../lib/i18n/runtime";
import { isWithinNI } from "../lib/transitRegion";
import { modeBadge } from "./transitBoard";
import { mlinkTicketUrl } from "../lib/translink";

type Mode = "rail" | "bus" | "tram" | "ferry" | "other" | string;
type Place = { stopId: string } | { lat: number; lng: number };

interface StopMatch {
  id: string;
  name: string;
  kind: string;
  lat: number | null;
  lng: number | null;
}
interface Leg {
  kind: string;
  mode: Mode | null;
  line: string | null;
  headsign: string | null;
  originName: string;
  destName: string;
  departPlanned: string | null;
  departEstimated: string | null;
  arrivePlanned: string | null;
  arriveEstimated: string | null;
  durationMin: number | null;
  realtime: boolean;
}
interface Trip {
  departPlanned: string | null;
  departEstimated: string | null;
  arrivePlanned: string | null;
  arriveEstimated: string | null;
  durationMin: number | null;
  interchanges: number;
  realtime: boolean;
  legs: Leg[];
}
interface ServiceInfo {
  title: string;
  content: string | null;
  priority: string | null;
  url: string | null;
}

/** EFA UTC ISO → epoch ms (append Z when tz-less), mirroring core/transit's parseEfaTime. */
function parseEfaTime(iso: string): number {
  const hasTz = /[zZ]$/.test(iso) || /[+-]\d{2}:?\d{2}$/.test(iso);
  return Date.parse(hasTz ? iso : `${iso}Z`);
}
function clock(iso: string | null): string {
  if (!iso) return "";
  const ms = parseEfaTime(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toLocaleTimeString(getFormatLocale(), { hour: "2-digit", minute: "2-digit" });
}

/** Which endpoint shape to send for a chosen match: id for stops/POIs, coord for addresses. */
function placeFromMatch(m: StopMatch): Place {
  if ((m.kind === "address" || m.kind === "other") && m.lat !== null && m.lng !== null) {
    return { lat: m.lat, lng: m.lng };
  }
  return { stopId: m.id };
}

/** The single transit mode shared by all a trip's ridden legs, or null when mixed / none. */
function uniformMode(legs: Leg[]): Mode | null {
  const modes = new Set(legs.filter((l) => l.kind === "transit" && l.mode).map((l) => l.mode as Mode));
  return modes.size === 1 ? ([...modes][0] as Mode) : null;
}

/** i18n key under planJourney for a mode tag; tram surfaces as "Glider" in NI, coach as "Bus". */
function modeLabelKey(mode: Mode): "rail" | "bus" | "glider" | "ferry" {
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

/** A transit leg's mode is excluded when its include-toggle is off (bus toggle covers Glider too). */
function tripUsesExcludedMode(trip: Trip, includeBus: boolean, includeRail: boolean): boolean {
  return trip.legs.some((l) => {
    if (l.kind !== "transit" || !l.mode) return false;
    if (l.mode === "rail") return !includeRail;
    return !includeBus; // bus / tram (Glider) / coach / other
  });
}

export function PlanJourney({
  destName,
  destLat,
  destLng,
  variant = "plan",
  orderAheadPrepMins,
}: {
  destName?: string;
  destLat?: number;
  destLng?: number;
  variant?: "plan" | "getHere";
  /** When the destination is a Food to Go venue, its prep time — shown against the journey ETA. */
  orderAheadPrepMins?: number | undefined;
}) {
  const t = useTranslations("planJourney");
  const [open, setOpen] = useState(false);
  const hasDest = typeof destLat === "number" && typeof destLng === "number";
  const [from, setFrom] = useState<{ label: string; place: Place } | null>(null);
  const [to, setTo] = useState<{ label: string; place: Place } | null>(
    hasDest && destName ? { label: destName, place: { lat: destLat!, lng: destLng! } } : null,
  );
  const [whenMode, setWhenMode] = useState<"now" | "depart" | "arrive">("now");
  const now = useRef(new Date());
  const [date, setDate] = useState(() => toDateInput(now.current));
  const [time, setTime] = useState(() => toTimeInput(now.current));
  // Mode-include filters (design surface 1c). Both on by default; unchecking one asks EFA to plan
  // around that mode and drops any journey still using it.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [includeBus, setIncludeBus] = useState(true);
  const [includeRail, setIncludeRail] = useState(true);
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [alerts, setAlerts] = useState<ServiceInfo[]>([]);
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [geoErr, setGeoErr] = useState(false);

  const swap = () => {
    setFrom(to);
    setTo(from);
    setTrips(null);
  };

  const useMyLocation = useCallback(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setGeoErr(true);
      return;
    }
    setLocating(true);
    setGeoErr(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setFrom({ label: t("myLocation"), place: { lat: pos.coords.latitude, lng: pos.coords.longitude } });
      },
      () => {
        setLocating(false);
        setGeoErr(true);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  }, [t]);

  const find = useCallback(async () => {
    if (!from || !to) {
      setStatus("need-both");
      return;
    }
    setLoading(true);
    setStatus("");
    setTrips(null);
    setAlerts([]);
    try {
      const body: Record<string, unknown> = { origin: from.place, destination: to.place };
      if (whenMode !== "now") {
        body.date = date;
        body.time = time;
        body.arriveBy = whenMode === "arrive";
      }
      if (!includeBus) body.includeBus = false;
      if (!includeRail) body.includeRail = false;
      const res = await fetch("/api/transit/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { status?: string; trips?: Trip[]; alerts?: ServiceInfo[] };
      // Correct-either-way: whether or not EFA honoured excludedMeans, never show a journey that
      // still uses an excluded mode.
      const filtered = (data.trips ?? []).filter((tr) => !tripUsesExcludedMode(tr, includeBus, includeRail));
      setStatus(data.status ?? "error");
      setTrips(filtered);
      setAlerts(data.alerts ?? []);
    } catch {
      setStatus("error");
      setTrips([]);
    } finally {
      setLoading(false);
    }
  }, [from, to, whenMode, date, time, includeBus, includeRail]);

  // Self-hiding like NearbyDepartures: when anchored to a place outside NI, Translink can't plan
  // it, so render nothing. (Hooks above always run; only the output is gated.)
  if (hasDest && !isWithinNI(destLat!, destLng!)) return null;

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={triggerStyle}>
        <Icon name="locate" size={16} />
        {variant === "getHere" ? t("getHereTitle") : t("trigger")}
      </button>
    );
  }

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 15, color: "var(--ink-hi)" }}>
          {variant === "getHere" ? t("getHereTitle") : t("title")}
        </div>
        <button type="button" onClick={() => setOpen(false)} aria-label={t("close")} style={iconBtn}>
          <Icon name="close" size={16} />
        </button>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <StopField
          label={t("from")}
          placeholder={t("fromPlaceholder")}
          value={from}
          onChange={setFrom}
          onUseMyLocation={useMyLocation}
          myLocationLabel={locating ? t("locating") : t("useMyLocation")}
        />
        <div style={{ display: "flex", justifyContent: "center", margin: "-4px 0" }}>
          <button type="button" onClick={swap} aria-label={t("swap")} style={{ ...iconBtn, transform: "rotate(90deg)" }}>
            ⇄
          </button>
        </div>
        <StopField label={t("to")} placeholder={t("toPlaceholder")} value={to} onChange={setTo} />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
        {(["now", "depart", "arrive"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setWhenMode(m)}
            style={{
              ...segBtn,
              background: whenMode === m ? "var(--crimson)" : "var(--paper-2)",
              color: whenMode === m ? "#fff" : "var(--ink-2)",
            }}
          >
            {m === "now" ? t("leaveNow") : m === "depart" ? t("departAt") : t("arriveBy")}
          </button>
        ))}
        {whenMode !== "now" ? (
          <div style={{ display: "flex", gap: 6, flex: 1, minWidth: 200 }}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={timeInput} aria-label={t("departAt")} />
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={timeInput} aria-label={t("arriveBy")} />
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 10 }}>
        <button
          type="button"
          onClick={() => setOptionsOpen((v) => !v)}
          aria-expanded={optionsOpen}
          style={optionsToggle}
        >
          {t("options")}
          {!includeBus || !includeRail ? <span style={optionsDot} aria-hidden /> : null}
          <span aria-hidden style={{ transform: optionsOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }}>›</span>
        </button>
        {optionsOpen ? (
          <div style={optionsBox}>
            <Check label={t("includeBuses")} checked={includeBus} onChange={setIncludeBus} />
            <Check label={t("includeTrains")} checked={includeRail} onChange={setIncludeRail} />
          </div>
        ) : null}
      </div>

      <button type="button" onClick={() => void find()} disabled={loading} style={findBtn}>
        {loading ? t("searching") : t("find")}
      </button>

      {geoErr ? <Note>{t("locationError")}</Note> : null}
      {status === "need-both" ? <Note>{t("needBoth")}</Note> : null}
      {status === "error" ? <Note>{t("error")}</Note> : null}
      {trips && trips.length === 0 && status !== "error" && status !== "need-both" ? <Note>{t("noResults")}</Note> : null}

      {alerts.length > 0 ? <AlertsBanner alerts={alerts} label={t("disruptions")} /> : null}

      {trips && trips.length > 0 ? (
        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          {orderAheadPrepMins != null ? (
            <OrderAheadHint prepMins={orderAheadPrepMins} journeyMin={trips[0]?.durationMin ?? null} t={t} />
          ) : null}
          {trips.map((trip, i) => (
            <TripCard key={i} trip={trip} t={t} />
          ))}
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
            Transport Information supplied by Translink Opendata API
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The bridge moment: a Food to Go venue's prep time set against the journey ETA, so the two numbers
 * meet. If prep ≤ journey, ordering now means it's ready on arrival; if prep is longer, we say how
 * much of a wait to expect. A success-tinted note above the trip cards.
 */
function OrderAheadHint({
  prepMins,
  journeyMin,
  t,
}: {
  prepMins: number;
  journeyMin: number | null;
  t: ReturnType<typeof useTranslations>;
}) {
  let detail: string;
  if (journeyMin == null) {
    detail = t("orderAhead.generic", { prep: prepMins });
  } else if (prepMins <= journeyMin) {
    detail = t("orderAhead.readyOnArrival", { prep: prepMins, journey: journeyMin });
  } else {
    detail = t("orderAhead.waitOnArrival", { prep: prepMins, journey: journeyMin, wait: prepMins - journeyMin });
  }
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: 12, background: "var(--success-tint)" }}>
      <span aria-hidden style={{ fontSize: 16, lineHeight: 1.2 }}>🥡</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--success)" }}>{t("orderAhead.title")}</div>
        <div style={{ marginTop: 1, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.4 }}>{detail}</div>
      </div>
    </div>
  );
}

function TripCard({ trip, t }: { trip: Trip; t: ReturnType<typeof useTranslations> }) {
  const dep = clock(trip.departEstimated ?? trip.departPlanned);
  const arr = clock(trip.arriveEstimated ?? trip.arrivePlanned);
  const uniform = uniformMode(trip.legs);
  const direct = trip.interchanges === 0;
  const changesLabel = direct
    ? t("direct")
    : `${trip.interchanges} ${trip.interchanges === 1 ? t("change") : t("changes")}`;
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 12, background: "var(--card)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 16, color: "var(--ink-hi)", fontVariantNumeric: "tabular-nums" }}>
          {dep} → {arr}
        </span>
        {trip.durationMin != null ? (
          <span style={{ fontSize: 13, color: "var(--ink-2)" }}>· {t("durationMin", { mins: trip.durationMin })}</span>
        ) : null}
        {trip.realtime ? <span style={liveDot} title={t("live")} /> : null}
        <span style={{ flex: 1 }} />
        {uniform ? (
          <span style={{ ...tagPill, color: modeBadge(uniform).bg, borderColor: "var(--line-2)" }}>
            {t(modeLabelKey(uniform))}
          </span>
        ) : null}
        <span style={{ ...tagPill, color: direct ? "#1a7f4b" : "var(--muted)", borderColor: "var(--line-2)" }}>
          {changesLabel}
        </span>
      </div>

      <LegTimeline legs={trip.legs} t={t} />

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {legSummary(trip.legs, t)}
        </span>
        <a href={mlinkTicketUrl()} target="_blank" rel="noopener noreferrer" style={buyLink}>
          <Icon name="ticket" size={13} aria-hidden />
          {t("buy")}
        </a>
      </div>
    </div>
  );
}

/** A proportional bar of the journey's legs — ridden legs coloured by mode, walks a faint gap. */
function LegTimeline({ legs, t }: { legs: Leg[]; t: ReturnType<typeof useTranslations> }) {
  return (
    <div style={timelineTrack}>
      {legs.map((leg, i) => {
        const w = Math.max(leg.durationMin ?? 1, 1);
        if (leg.kind === "walk") {
          return (
            <div
              key={i}
              title={leg.durationMin != null ? t("walkMin", { mins: leg.durationMin }) : t("walk")}
              style={{ ...timelineSeg, flex: `${w} 1 0`, minWidth: 20, background: "var(--paper-2)", color: "var(--muted)" }}
            >
              <Icon name="locate" size={11} aria-hidden />
            </div>
          );
        }
        const c = modeBadge(leg.mode ?? "other");
        return (
          <div
            key={i}
            title={`${leg.line ?? ""} · ${leg.originName} → ${leg.destName}`}
            style={{ ...timelineSeg, flex: `${w} 1 0`, minWidth: 48, background: c.bg, color: c.fg }}
          >
            <span style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>{leg.line}</span>
            {leg.durationMin != null && w >= 6 ? <span style={{ opacity: 0.85 }}>· {leg.durationMin}m</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/** One-line prose summary of the legs, e.g. "Walk 6 min · Glider G1 to Titanic Quarter · walk 7 min". */
function legSummary(legs: Leg[], t: ReturnType<typeof useTranslations>): string {
  return legs
    .map((l) =>
      l.kind === "walk"
        ? l.durationMin != null
          ? t("walkMin", { mins: l.durationMin })
          : t("walk")
        : `${l.line ?? ""} ${t("to_")} ${l.destName}`.trim(),
    )
    .join(" · ");
}

/** A checkbox row for the mode-include options. */
function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: "var(--ink-2)", cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ accentColor: "var(--crimson-700)", width: 16, height: 16 }} />
      {label}
    </label>
  );
}

/** A from/to autocomplete field backed by /api/transit/stops. Owns its own query + suggestions. */
function StopField({
  label,
  placeholder,
  value,
  onChange,
  onUseMyLocation,
  myLocationLabel,
}: {
  label: string;
  placeholder: string;
  value: { label: string; place: Place } | null;
  onChange: (v: { label: string; place: Place } | null) => void;
  onUseMyLocation?: () => void;
  myLocationLabel?: string;
}) {
  const [q, setQ] = useState(value?.label ?? "");
  const [sug, setSug] = useState<StopMatch[]>([]);
  const [openList, setOpenList] = useState(false);
  const [loading, setLoading] = useState(false);
  const selectedLabel = useRef<string | null>(value?.label ?? null);

  // Keep the input text in sync if the parent swaps the value (e.g. the Swap button).
  useEffect(() => {
    setQ(value?.label ?? "");
    selectedLabel.current = value?.label ?? null;
  }, [value]);

  // Debounced Stop-Finder lookup — skip when the current text is exactly the selected label.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 || term === selectedLabel.current) {
      setSug([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch("/api/transit/stops", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ q: term }),
        });
        const data = (await res.json()) as { matches?: StopMatch[] };
        if (!cancelled) {
          setSug(data.matches ?? []);
          setOpenList(true);
        }
      } catch {
        if (!cancelled) setSug([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q]);

  const pick = (m: StopMatch) => {
    selectedLabel.current = m.name;
    setQ(m.name);
    setSug([]);
    setOpenList(false);
    onChange({ label: m.name, place: placeFromMatch(m) });
  };

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
        <label style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>{label}</label>
        {onUseMyLocation ? (
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onUseMyLocation} style={{ all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--crimson-700)", fontWeight: 600 }}>
            <Icon name="locate" size={12} />
            {myLocationLabel}
          </button>
        ) : null}
      </div>
      <input
        value={q}
        placeholder={placeholder}
        onChange={(e) => {
          setQ(e.target.value);
          selectedLabel.current = null;
          if (value) onChange(null);
        }}
        onFocus={() => sug.length > 0 && setOpenList(true)}
        onBlur={() => setTimeout(() => setOpenList(false), 150)}
        style={fieldInput}
      />
      {openList && (loading || sug.length > 0) ? (
        <div style={dropdown}>
          {loading && sug.length === 0 ? (
            <div style={{ padding: "8px 10px", fontSize: 13, color: "var(--muted)" }}>…</div>
          ) : (
            sug.map((m) => (
              <button key={m.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m)} style={sugRow}>
                <Icon name={m.kind === "stop" ? "place" : "locate"} size={14} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 10 }}>{children}</div>;
}

/** A compact list of service notices / disruptions. `priority` high/veryHigh reads as a warning. */
function AlertsBanner({ alerts, label }: { alerts: ServiceInfo[]; label: string }) {
  const urgent = alerts.some((a) => a.priority === "high" || a.priority === "veryHigh");
  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 12px",
        borderRadius: 10,
        background: urgent ? "var(--crimson-tint)" : "var(--paper-2)",
        border: `1px solid ${urgent ? "var(--crimson-tint-2)" : "var(--line)"}`,
      }}
    >
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: urgent ? "var(--crimson-700)" : "var(--muted)", marginBottom: 4 }}>{label}</div>
      <div style={{ display: "grid", gap: 6 }}>
        {alerts.slice(0, 4).map((a, i) => (
          <div key={i} style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.4 }}>
            <span style={{ fontWeight: 600, color: "var(--ink-hi)" }}>{a.title}</span>
            {a.content ? <span> — {a.content}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function toTimeInput(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const triggerStyle: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "9px 14px",
  borderRadius: 10,
  border: "1px solid var(--line)",
  background: "var(--card)",
  color: "var(--ink-hi)",
  fontSize: 14,
  fontWeight: 600,
};
const panelStyle: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 16,
  background: "var(--card)",
  padding: 16,
  boxShadow: "var(--sh-1)",
};
const iconBtn: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: 8,
  color: "var(--ink-2)",
  background: "var(--paper-2)",
};
const fieldInput: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  border: "1px solid var(--line)",
  borderRadius: 10,
  background: "var(--paper)",
  fontSize: 14,
  color: "var(--ink)",
  outline: "none",
};
const dropdown: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  zIndex: 20,
  marginTop: 4,
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: 10,
  boxShadow: "var(--sh-2)",
  overflow: "hidden",
  maxHeight: 240,
  overflowY: "auto",
};
const sugRow: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "9px 11px",
  fontSize: 13.5,
  color: "var(--ink)",
  width: "100%",
  boxSizing: "border-box",
};
const segBtn: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  padding: "6px 11px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
};
const timeInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  boxSizing: "border-box",
  padding: "6px 8px",
  border: "1px solid var(--line)",
  borderRadius: 8,
  background: "var(--paper)",
  fontSize: 13,
  color: "var(--ink)",
};
const findBtn: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "block",
  textAlign: "center",
  marginTop: 12,
  padding: "11px 14px",
  borderRadius: 10,
  background: "var(--crimson)",
  color: "#fff",
  fontSize: 14,
  fontWeight: 700,
};
const liveDot: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "var(--success)",
  display: "inline-block",
};
const tagPill: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: ".08em",
  textTransform: "uppercase",
  border: "1px solid var(--line-2)",
  borderRadius: 999,
  padding: "3px 8px",
  whiteSpace: "nowrap",
};
const timelineTrack: React.CSSProperties = {
  display: "flex",
  gap: 3,
  height: 26,
  alignItems: "stretch",
};
const timelineSeg: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  borderRadius: 6,
  padding: "0 8px",
  fontFamily: "var(--ui)",
  fontSize: 11.5,
  overflow: "hidden",
  whiteSpace: "nowrap",
};
const buyLink: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  flex: "0 0 auto",
  textDecoration: "none",
  fontFamily: "var(--mono)",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: ".06em",
  textTransform: "uppercase",
  color: "var(--crimson-700)",
  border: "1px solid var(--line-2)",
  borderRadius: 999,
  padding: "4px 10px",
};
const optionsToggle: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontFamily: "var(--mono)",
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: ".06em",
  textTransform: "uppercase",
  color: "var(--ink-2)",
};
const optionsDot: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--crimson-700)",
  display: "inline-block",
};
const optionsBox: React.CSSProperties = {
  display: "grid",
  gap: 8,
  marginTop: 10,
  padding: "12px 14px",
  border: "1px solid var(--line)",
  borderRadius: 10,
  background: "var(--paper-2)",
};
