/**
 * NearbyDepartures — the Northern Ireland live-transit card (Translink Opendata).
 *
 * Shown on Home and Explore under a place that sits inside NI. It asks the server-side hop
 * (POST /api/transit/nearby) for the live departure board of the nearest Translink stop and
 * renders a compact board: the stop, a handful of upcoming services with realtime "due in" times,
 * mode filters, disruptions, and the licence-required attribution. A "show all" affordance opens
 * the fuller StopBoardPanel. Everything is best-effort and self-hiding — outside NI, or when the
 * feature isn't configured / has nothing to show, the component renders nothing.
 *
 * The NI check runs CLIENT-SIDE first (lib/transitRegion mirrors core's geofence) so we don't
 * even POST for an obviously-out-of-region place; the server geofences again as the real gate.
 *
 * The board row primitives (roundel, destination, countdown, filters) live in ./transitBoard and
 * are shared verbatim with StopBoardPanel so the two surfaces can never drift.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@roam/design";
import { isWithinNI, isWithinIreland, TRANSLINK_ATTRIBUTION } from "../lib/transitRegion";
import { detectMapsPlatform, directionsToPlaceUrl, type MapsPlatform } from "../lib/directions";
import {
  type Board,
  useBoardView,
  FilterControls,
  DepartureRow,
  Disruptions,
  walkMinutes,
  listStyle,
  attributionStyle,
} from "./transitBoard";
import { StopBoardPanel } from "./StopBoardPanel";
import { SaveStopButton } from "./SaveStopButton";

/** How many departures the compact widget shows before deferring the rest to the full panel. */
const MAX_ROWS = 6;

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
            <li key={i} style={{ ...skeletonRow, opacity: 1 - i * 0.28 }}>
              <span style={{ width: 46, height: 24, borderRadius: 7, background: "var(--paper-2)" }} />
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
    return <LiveBoard board={board} placeName={placeName} lat={lat} lng={lng} />;
  }

  // Anywhere on the island of Ireland without a live board → the "coming soon" placeholder.
  return <TransitComingSoon placeName={placeName} />;
}

/**
 * LiveBoard — the compact board itself, split out so it can own the interactive state (mode
 * filter, sort, the full-panel toggle) with hooks that never sit behind a conditional return.
 * Mounted only when the parent has an OK board with a stop, so `board.stop` is guaranteed present.
 */
function LiveBoard({
  board,
  placeName,
  lat,
  lng,
}: {
  board: Board;
  placeName: string;
  lat: number;
  lng: number;
}) {
  const t = useTranslations("nearbyDepartures");
  const stop = board.stop!;
  const { filter, setFilter, sort, setSort, groups, rows } = useBoardView(board.departures);
  const [panelOpen, setPanelOpen] = useState(false);
  // Detect the maps platform once (client-only) so the Directions link routes to the right app.
  const [platform] = useState<MapsPlatform>(() =>
    typeof navigator !== "undefined"
      ? detectMapsPlatform(navigator.userAgent, navigator.maxTouchPoints, navigator.platform)
      : "web",
  );

  const visible = rows.slice(0, MAX_ROWS);
  const total = board.departures.length;
  const hasMore = total > visible.length;
  const subline =
    typeof stop.distanceM === "number"
      ? `${stop.name} · ${t("metres", { distance: stop.distanceM })} · ${t("walk", { mins: walkMinutes(stop.distanceM) })}`
      : stop.name;

  return (
    <div style={cardStyle}>
      <BoardHeader
        title={t("title")}
        subline={subline}
        directionsHref={directionsToPlaceUrl(stop.lat, stop.lng, platform)}
        directionsLabel={t("directions")}
        saveButton={<SaveStopButton stop={{ stopId: stop.id, name: stop.name, lat: stop.lat, lng: stop.lng }} />}
      />

      <FilterControls
        t={t}
        groups={groups}
        filter={filter}
        setFilter={setFilter}
        sort={sort}
        setSort={setSort}
        showSort={board.departures.length > 1}
      />

      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--muted)", padding: "var(--space-2) 0 2px" }}>
          {t("noDepartures")}
        </div>
      ) : (
        <ul style={listStyle}>
          {visible.map((d, i) => (
            <DepartureRow key={`${d.line}-${d.plannedTime}-${i}`} d={d} placeName={placeName} t={t} />
          ))}
        </ul>
      )}

      {total > 0 ? (
        <button type="button" onClick={() => setPanelOpen(true)} style={openBoardStyle}>
          {hasMore ? t("showAll", { count: total }) : t("openBoard")}
          <span aria-hidden> →</span>
        </button>
      ) : null}

      <Disruptions alerts={board.alerts} t={t} />

      <div style={attributionStyle}>{board.attribution || TRANSLINK_ATTRIBUTION}</div>

      {panelOpen ? (
        <StopBoardPanel
          initialBoard={board}
          placeName={placeName}
          lat={lat}
          lng={lng}
          platform={platform}
          onClose={() => setPanelOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * TransitComingSoon — the geographical teaser shown across the island of Ireland while live
 * departures aren't available (outside NI where there's no live board). Deliberately Ireland-only:
 * Translink is an Ireland operator, so this never appears elsewhere.
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
 * stop · distance · walk-time subline, and an optional right-aligned Directions link that hands
 * off to the device's maps app. Matches the icon-chip + display-title language of the home widgets.
 */
function BoardHeader({
  title,
  subline,
  directionsHref,
  directionsLabel,
  saveButton,
}: {
  title: string;
  subline: string;
  directionsHref?: string;
  directionsLabel?: string;
  saveButton?: React.ReactNode;
}) {
  const hasActions = (directionsHref && directionsLabel) || saveButton;
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
      {hasActions ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5, flex: "0 0 auto" }}>
          {directionsHref && directionsLabel ? (
            <a href={directionsHref} target="_blank" rel="noopener noreferrer" style={directionsLinkStyle}>
              <Icon name="locate" size={12} aria-hidden />
              {directionsLabel}
            </a>
          ) : null}
          {saveButton}
        </div>
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

const directionsLinkStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  flex: "0 0 auto",
  fontFamily: "var(--mono)",
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: ".1em",
  textTransform: "uppercase",
  color: "var(--crimson-700)",
  textDecoration: "none",
  border: "1px solid var(--line-2)",
  borderRadius: 999,
  padding: "3px 9px 3px 7px",
};

const openBoardStyle: React.CSSProperties = {
  width: "100%",
  marginTop: "var(--space-2)",
  border: "1px solid var(--line)",
  background: "var(--paper-2)",
  cursor: "pointer",
  borderRadius: 10,
  padding: "9px 0",
  fontFamily: "var(--mono)",
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: ".08em",
  textTransform: "uppercase",
  color: "var(--ink-2)",
};

const skeletonRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 12,
  padding: "7px 0",
  borderTop: "1px solid var(--line)",
};
