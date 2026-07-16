/**
 * NearbyFriends — the "Around you" card on /friends (PR 2 of "share with friends").
 *
 * Two INDEPENDENT, privacy-symmetric actions:
 *   1. See who's nearby — uses your current position (asked for on tap, never stored) to list the
 *      friends who are CURRENTLY sharing their location, near→far. You needn't share to look.
 *   2. Share your location — broadcasts YOUR precise position to your friends for a bounded window
 *      (1h / 4h / 8h), auto-expiring. Stop any time; the coordinate is nulled the moment you do.
 *
 * The friend-only boundary is enforced in the DB (migration 0093): friends_nearby() is are_friends-
 * gated, and writes go through set_my_location/stop_my_location scoped to auth.uid(). This component
 * only ever calls the presence.* procedures — it never reads a location any other way.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, Button, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { PresencePill } from "./PresenceStatus";

type Availability = "free_to_meet" | "out_and_about" | "heads_down";

interface FriendNearby {
  profile_id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  availability: Availability | null;
  note: string | null;
  lat: number;
  lng: number;
  distance_m: number;
  geo_expires_at: string | null;
}

const TTL_CHOICES = [1, 4, 8] as const;

/** Local mirror of @roam/core's geo.formatDistance (same rationale as VenueCard). */
function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  const km = metres / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/** Promisified single-shot geolocation with a high-accuracy fix (we want to actually meet up). */
function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 8000,
      maximumAge: 30_000,
    });
  });
}

function displayName(t: ReturnType<typeof useTranslations>, p: FriendNearby): string {
  if (p.display_name && p.display_name.trim()) return p.display_name.trim();
  if (p.handle && p.handle.trim()) return `@${p.handle.trim()}`;
  return t("someone");
}

function Avatar({ p, size }: { p: FriendNearby; size: number }) {
  if (p.avatar_url) {
    // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
    return <img src={p.avatar_url} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
  }
  const initial = (p.display_name ?? p.handle ?? "·").replace(/^@/, "").charAt(0).toUpperCase() || "·";
  return (
    <span aria-hidden style={{ width: size, height: size, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: size * 0.42, flexShrink: 0 }}>
      {initial}
    </span>
  );
}

export function NearbyFriends() {
  const t = useTranslations("presence");
  const trpc = useTrpc();
  const session = useSession();
  const hasSession = !!session;

  const [nearby, setNearby] = useState<FriendNearby[] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [share, setShare] = useState<{ sharing: boolean; expiresAt: string | null }>({ sharing: false, expiresAt: null });
  const [ttl, setTtl] = useState<(typeof TTL_CHOICES)[number]>(1);
  const [sharePending, setSharePending] = useState(false);
  const cancelled = useRef(false);

  const loadShareState = useCallback(async () => {
    const q = trpc.presence.myLocationShare as unknown as { query: () => Promise<{ sharing: boolean; expiresAt: string | null }> };
    return q.query();
  }, [trpc]);

  const queryNearby = useCallback(
    async (lat: number, lng: number) => {
      const q = trpc.presence.friendsNearby as unknown as {
        query: (i: { lat: number; lng: number; radiusM?: number }) => Promise<FriendNearby[]>;
      };
      return q.query({ lat, lng });
    },
    [trpc],
  );

  useEffect(() => {
    cancelled.current = false;
    if (hasSession) {
      loadShareState()
        .then((s) => {
          if (!cancelled.current) setShare(s);
        })
        .catch(() => {});
    }
    return () => {
      cancelled.current = true;
    };
  }, [hasSession, loadShareState]);

  const seeNearby = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const pos = await getPosition();
      const rows = await queryNearby(pos.coords.latitude, pos.coords.longitude);
      if (!cancelled.current) setNearby(rows);
    } catch {
      if (!cancelled.current) setError(t("locError"));
    } finally {
      if (!cancelled.current) setLoading(false);
    }
  }, [queryNearby, t]);

  const startShare = useCallback(async () => {
    setSharePending(true);
    setError(null);
    try {
      const pos = await getPosition();
      const m = trpc.presence.shareLocation as unknown as {
        mutate: (i: { lat: number; lng: number; accuracyM?: number | null; ttlHours?: number }) => Promise<{ expiresAt: string | null }>;
      };
      const res = await m.mutate({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyM: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null,
        ttlHours: ttl,
      });
      if (cancelled.current) return;
      setShare({ sharing: true, expiresAt: res.expiresAt });
      // We have a fresh fix — surface who's around too, so sharing immediately shows value.
      const rows = await queryNearby(pos.coords.latitude, pos.coords.longitude);
      if (!cancelled.current) setNearby(rows);
    } catch {
      if (!cancelled.current) setError(t("locError"));
    } finally {
      if (!cancelled.current) setSharePending(false);
    }
  }, [trpc, ttl, queryNearby, t]);

  const stopShare = useCallback(async () => {
    setSharePending(true);
    try {
      const m = trpc.presence.stopSharingLocation as unknown as { mutate: () => Promise<{ stopped: true }> };
      await m.mutate();
      if (!cancelled.current) setShare({ sharing: false, expiresAt: null });
    } catch {
      /* leave state; user can retry */
    } finally {
      if (!cancelled.current) setSharePending(false);
    }
  }, [trpc]);

  if (!hasSession) return null;

  const untilLabel = share.expiresAt
    ? new Date(share.expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "";

  return (
    <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-5)" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-3)" }}>
        {t("nearbyTitle")}
      </div>

      {/* See who's nearby */}
      {nearby === undefined ? (
        <Button variant="neutral" size="sm" onClick={() => void seeNearby()} disabled={loading}>
          {loading ? t("locating") : t("seeNearby")}
        </Button>
      ) : nearby.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-2)" }}>
          <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 13.5 }}>{t("noneNearby")}</p>
          <button type="button" onClick={() => void seeNearby()} disabled={loading} style={{ all: "unset", cursor: "pointer", color: "var(--muted)", fontSize: 12.5, fontWeight: 600 }}>
            {loading ? t("locating") : t("refresh")}
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-1)" }}>
          {nearby.map((p) => (
            <div key={p.profile_id} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "6px 4px" }}>
              <Link href={`/u/${p.handle ?? p.profile_id}`} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", textDecoration: "none", color: "inherit", flex: 1, minWidth: 0 }}>
                <Avatar p={p} size={32} />
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName(t, p)}</span>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>{t("distanceAway", { distance: formatDistance(p.distance_m) })}</span>
                </span>
              </Link>
              {p.availability ? <PresencePill availability={p.availability} note={p.note} /> : null}
            </div>
          ))}
        </div>
      )}

      {/* Divider + share control */}
      <div style={{ borderTop: "1px solid var(--line)", margin: "var(--space-4) 0 var(--space-3)" }} />

      {share.sharing ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, color: "var(--ink-2)", fontWeight: 600 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--positive, #1f9d55)", flexShrink: 0 }} />
            {t("sharingUntil", { time: untilLabel })}
          </span>
          <Button variant="neutral" size="sm" onClick={() => void stopShare()} disabled={sharePending}>
            {t("stopSharing")}
          </Button>
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
            <Icon name="locate" size={18} />
            <div style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.45 }}>{t("shareBlurb")}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
            {/* Duration segmented control */}
            <div role="group" aria-label={t("shareDuration")} style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 999, overflow: "hidden" }}>
              {TTL_CHOICES.map((h) => {
                const on = ttl === h;
                return (
                  <button
                    key={h}
                    type="button"
                    onClick={() => setTtl(h)}
                    aria-pressed={on}
                    style={{ all: "unset", cursor: "pointer", padding: "7px 12px", fontSize: 13, fontWeight: 600, color: on ? "var(--crimson-700)" : "var(--muted)", background: on ? "var(--crimson-tint)" : "transparent" }}
                  >
                    {t("hoursShort", { h })}
                  </button>
                );
              })}
            </div>
            <Button variant="pri" size="sm" onClick={() => void startShare()} disabled={sharePending}>
              {sharePending ? t("sharing") : t("shareCta")}
            </Button>
          </div>
        </div>
      )}

      {error ? <p style={{ margin: "var(--space-3) 0 0", color: "var(--crimson-700)", fontSize: 12.5 }}>{error}</p> : null}
    </Card>
  );
}
