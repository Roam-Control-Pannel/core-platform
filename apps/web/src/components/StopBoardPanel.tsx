/**
 * StopBoardPanel — the expanded stop board (design surface 1b), a modal over the compact widget.
 *
 * Shows the FULL departure board for a stop with the same mode filters + sort, the disruptions,
 * a Directions hand-off and a "Buy a ticket" hand-off to mLink (Translink's ticketing app — fares
 * aren't in the open API, so we hand off rather than price in-app). While open it auto-refreshes
 * the board on an interval and shows an "updated · refreshes every Ns" stamp.
 *
 * DELIBERATELY NOT in the mockup's original form: the live-vehicle map and the £ fare panel are
 * cut — Translink NI publishes no vehicle-position feed and no open fare data (Phase-0 recon).
 *
 * COST: the refresh polls /api/transit/nearby, which the server caches for 45s, so a single open
 * panel spends at most ~1 EFA request per cache window — an acceptable cost for a surface the user
 * deliberately opened. The interval is comfortably above the cache TTL's practical hit rate.
 *
 * The board row primitives are shared verbatim with the compact widget via ./transitBoard.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { Icon } from "@roam/design";
import { TRANSLINK_ATTRIBUTION } from "../lib/transitRegion";
import { directionsToPlaceUrl, type MapsPlatform } from "../lib/directions";
import { mlinkTicketUrl } from "../lib/translink";
import { getFormatLocale } from "../lib/i18n/runtime";
import {
  type Board,
  useBoardView,
  FilterControls,
  DepartureRow,
  Disruptions,
  walkMinutes,
  listStyle,
} from "./transitBoard";
import { SaveStopButton } from "./SaveStopButton";

/** How often the open panel re-polls the board. Above the server's 45s cache TTL's hot window. */
const REFRESH_MS = 30_000;

export function StopBoardPanel({
  initialBoard,
  placeName,
  lat,
  lng,
  platform,
  stopId,
  stopName,
  onClose,
}: {
  /** The board the widget already holds. Omit when opening cold (e.g. from a saved stop) — the
   *  panel then fetches on open. */
  initialBoard?: Board;
  placeName: string;
  lat: number;
  lng: number;
  platform: MapsPlatform;
  /** Stop identity for the Save button + header while a cold-opened board loads. */
  stopId?: string;
  stopName?: string;
  onClose: () => void;
}) {
  const t = useTranslations("nearbyDepartures");
  const [board, setBoard] = useState<Board | null>(initialBoard ?? null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const { filter, setFilter, sort, setSort, groups, rows } = useBoardView(board?.departures ?? []);

  const stop = board?.stop ?? null;
  // Save reference: the live stop when loaded, else the identity we were opened with.
  const saveRef =
    stop
      ? { stopId: stop.id, name: stop.name, lat: stop.lat, lng: stop.lng }
      : stopId && stopName
        ? { stopId, name: stopName, lat, lng }
        : null;

  // Re-fetch the board (used by the interval and after mount). Latest-wins via a generation ref.
  const gen = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++gen.current;
    try {
      const res = await fetch("/api/transit/nearby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng }),
      });
      const data = (await res.json()) as Board;
      if (gen.current !== mine) return;
      if (data.status === "ok" && data.stop) {
        setBoard(data);
        setUpdatedAt(new Date());
      }
    } catch {
      /* keep the last good board; a failed refresh is silent */
    }
  }, [lat, lng]);

  // Auto-refresh while open; also close on Escape and lock the page behind the modal.
  useEffect(() => {
    if (!initialBoard) void refresh(); // cold open (e.g. from a saved stop) → fetch immediately
    const id = window.setInterval(refresh, REFRESH_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.clearInterval(id);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [refresh, onClose, initialBoard]);

  if (typeof document === "undefined") return null;

  const subline = stop
    ? typeof stop.distanceM === "number"
      ? `${t("metres", { distance: stop.distanceM })} · ${t("walk", { mins: walkMinutes(stop.distanceM) })}`
      : t("nearestStop")
    : "";
  const updatedLabel = updatedAt
    ? t("updatedRefreshes", {
        time: updatedAt.toLocaleTimeString(getFormatLocale(), { hour: "2-digit", minute: "2-digit" }),
        secs: REFRESH_MS / 1000,
      })
    : t("refreshesEvery", { secs: REFRESH_MS / 1000 });

  const title = stop?.name ?? stopName ?? t("title");
  const dLat = stop?.lat ?? lat;
  const dLng = stop?.lng ?? lng;

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={title} onClick={onClose} style={scrim}>
      <div onClick={(e) => e.stopPropagation()} style={panel}>
        {/* Header */}
        <div style={panelHead}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="t-mono-label" style={{ fontSize: 10, color: "var(--muted)", marginBottom: 4 }}>
              {t("nearestStop")}
            </div>
            <div
              className="t-h3"
              style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 21, color: "var(--ink)", lineHeight: 1.15 }}
            >
              {title}
            </div>
            {subline ? <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 3 }}>{subline}</div> : null}
          </div>
          <button type="button" aria-label={t("close")} onClick={onClose} style={closeBtn}>
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* Actions */}
        <div style={actionRow}>
          <a href={directionsToPlaceUrl(dLat, dLng, platform)} target="_blank" rel="noopener noreferrer" style={actionBtn}>
            <Icon name="locate" size={14} aria-hidden />
            {t("directions")}
          </a>
          {saveRef ? <SaveStopButton stop={saveRef} variant="action" /> : null}
          <a href={mlinkTicketUrl()} target="_blank" rel="noopener noreferrer" style={{ ...actionBtn, ...actionBtnPrimary }}>
            <Icon name="ticket" size={14} aria-hidden />
            {t("buyTicket")}
          </a>
        </div>

        {/* Scrollable board */}
        <div style={boardScroll}>
          <FilterControls
            t={t}
            groups={groups}
            filter={filter}
            setFilter={setFilter}
            sort={sort}
            setSort={setSort}
            showSort={(board?.departures.length ?? 0) > 1}
          />
          {board === null ? (
            <div style={{ fontSize: 13, color: "var(--muted)", padding: "var(--space-2) 0" }}>{t("loading")}</div>
          ) : rows.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--muted)", padding: "var(--space-2) 0" }}>{t("noDepartures")}</div>
          ) : (
            <ul style={listStyle}>
              {rows.map((d, i) => (
                <DepartureRow key={`${d.line}-${d.plannedTime}-${i}`} d={d} placeName={placeName} t={t} />
              ))}
            </ul>
          )}
          <Disruptions alerts={board?.alerts} t={t} />
        </div>

        {/* Footer: refresh stamp + attribution */}
        <div style={panelFoot}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span className="roam-live-pulse" aria-hidden style={{ width: 5, height: 5, borderRadius: "50%", background: "#1a9e57" }} />
            {updatedLabel}
          </span>
          <span style={{ color: "var(--faint)" }}>{board?.attribution || TRANSLINK_ATTRIBUTION}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ── styles ───────────────────────────────────────────────────────────────────────────────── */

const scrim: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 300,
  display: "grid",
  placeItems: "end center",
  background: "rgba(33,29,26,.55)",
  padding: 0,
};

const panel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "min(560px, 100%)",
  maxHeight: "92vh",
  background: "var(--card)",
  borderRadius: "18px 18px 0 0",
  border: "1px solid var(--line)",
  boxShadow: "0 -8px 40px rgba(0,0,0,.22)",
  overflow: "hidden",
};

const panelHead: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "var(--space-4) var(--space-4) var(--space-3)",
};

const closeBtn: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  borderRadius: 8,
  color: "var(--muted)",
  background: "var(--paper-2)",
  flex: "0 0 auto",
};

const actionRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  padding: "0 var(--space-4) var(--space-3)",
};

const actionBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  textDecoration: "none",
  fontFamily: "var(--ui)",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--ink)",
  background: "var(--paper-2)",
  border: "1px solid var(--line)",
  borderRadius: 10,
  padding: "8px 14px",
};

const actionBtnPrimary: React.CSSProperties = {
  color: "#fff",
  background: "var(--crimson-700)",
  border: "1px solid var(--crimson-700)",
};

const boardScroll: React.CSSProperties = {
  overflowY: "auto",
  padding: "0 var(--space-4)",
  flex: 1,
};

const panelFoot: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "2px 10px",
  justifyContent: "space-between",
  padding: "var(--space-3) var(--space-4)",
  borderTop: "1px solid var(--line)",
  fontFamily: "var(--mono)",
  fontSize: 9.5,
  letterSpacing: ".04em",
  color: "var(--muted)",
};
