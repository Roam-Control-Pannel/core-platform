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
import { Icon, type IconName } from "@roam/design";
import { getFormatLocale } from "../lib/i18n/runtime";
import { isWithinNI } from "../lib/transitRegion";

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

function modeIcon(mode: Mode | null): IconName {
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

export function PlanJourney({
  destName,
  destLat,
  destLng,
  variant = "plan",
}: {
  destName?: string;
  destLat?: number;
  destLng?: number;
  variant?: "plan" | "getHere";
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
      const res = await fetch("/api/transit/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { status?: string; trips?: Trip[]; alerts?: ServiceInfo[] };
      setStatus(data.status ?? "error");
      setTrips(data.trips ?? []);
      setAlerts(data.alerts ?? []);
    } catch {
      setStatus("error");
      setTrips([]);
    } finally {
      setLoading(false);
    }
  }, [from, to, whenMode, date, time]);

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

function TripCard({ trip, t }: { trip: Trip; t: ReturnType<typeof useTranslations> }) {
  const dep = clock(trip.departEstimated ?? trip.departPlanned);
  const arr = clock(trip.arriveEstimated ?? trip.arrivePlanned);
  const changesLabel =
    trip.interchanges === 0 ? t("direct") : `${trip.interchanges} ${trip.interchanges === 1 ? t("change") : t("changes")}`;
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 12, background: "var(--card)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 16, color: "var(--ink-hi)" }}>{dep} → {arr}</span>
        {trip.durationMin != null ? <span style={{ fontSize: 13, color: "var(--ink-2)" }}>· {t("durationMin", { mins: trip.durationMin })}</span> : null}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: "var(--muted)" }}>{changesLabel}</span>
        {trip.realtime ? <span style={liveDot} title={t("live")} /> : null}
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {trip.legs.map((leg, i) => (
          <LegRow key={i} leg={leg} t={t} />
        ))}
      </div>
    </div>
  );
}

function LegRow({ leg, t }: { leg: Leg; t: ReturnType<typeof useTranslations> }) {
  const isWalk = leg.kind === "walk";
  const dep = clock(leg.departEstimated ?? leg.departPlanned);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
      <span style={{ width: 22, display: "inline-flex", justifyContent: "center", color: "var(--ink-2)" }}>
        {isWalk ? <span style={{ fontSize: 11, color: "var(--muted)" }}>⏱</span> : <Icon name={modeIcon(leg.mode)} size={16} />}
      </span>
      {isWalk ? (
        <span style={{ color: "var(--ink-2)" }}>{leg.durationMin != null ? t("walkMin", { mins: leg.durationMin }) : t("walk")}</span>
      ) : (
        <>
          <span style={{ fontWeight: 600, color: "var(--ink-hi)", background: "var(--paper-2)", borderRadius: 6, padding: "1px 7px" }}>{leg.line}</span>
          <span style={{ color: "var(--ink-2)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {leg.originName} {t("to_")} {leg.destName}
          </span>
          {dep ? <span style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{dep}</span> : null}
        </>
      )}
    </div>
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
