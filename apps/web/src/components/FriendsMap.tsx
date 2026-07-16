/**
 * FriendsMap — a small live map of the friends currently sharing their location nearby, plus a
 * "you" marker at the caller's position. Enhancement to the NearbyFriends list (PR 2 follow-up).
 *
 * Same no-key Leaflet + OpenStreetMap approach as VenueMap (MIT / free tiles, no SDK, no billing),
 * and the same discipline: Leaflet touches window/document, so it's imported DYNAMICALLY inside an
 * effect — never at module load — so SSR / `next build` never evaluate it on the server. Pins are
 * custom divIcons (no bundler-fragile default-marker images). A friend pin shows their initial and
 * links to their profile on click; the "you" pin is a plain dot.
 *
 * Only friends who opted to share see each other here — this renders whatever friends_nearby()
 * already returned (are_friends-gated in the DB); it introduces no new data path.
 */
"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";

export interface FriendMarker {
  id: string;
  name: string;
  lat: number;
  lng: number;
  handle: string | null;
}

export function FriendsMap({
  friends,
  me,
  className,
}: {
  friends: FriendMarker[];
  me: { lat: number; lng: number };
  className?: string | undefined;
}) {
  const t = useTranslations("presence");
  const tv = useTranslations("venueMap");
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const layerRef = useRef<Leaflet.LayerGroup | null>(null);
  const leafletRef = useRef<typeof Leaflet | null>(null);
  const router = useRouter();

  // Latest props read inside the imperative Leaflet callbacks without re-subscribing.
  const friendsRef = useRef(friends);
  friendsRef.current = friends;
  const meRef = useRef(me);
  meRef.current = me;

  function renderMarkers() {
    const L = leafletRef.current;
    const layer = layerRef.current;
    const map = mapRef.current;
    if (!L || !layer || !map) return;
    layer.clearLayers();
    const points: [number, number][] = [[meRef.current.lat, meRef.current.lng]];

    // "You" — a plain blue dot, no interaction.
    const youIcon = L.divIcon({
      className: "",
      html: `<span style="display:block;width:14px;height:14px;border-radius:50%;background:#2563eb;border:2px solid #fff;box-shadow:0 1px 3px rgba(33,29,26,.45)"></span>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
    L.marker([meRef.current.lat, meRef.current.lng], { icon: youIcon, title: t("youAreHere") }).addTo(layer);

    for (const f of friendsRef.current) {
      if (typeof f.lat !== "number" || typeof f.lng !== "number") continue;
      const initial = (f.name || "·").replace(/^@/, "").charAt(0).toUpperCase() || "·";
      const icon = L.divIcon({
        className: "",
        html: `<span style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#C2123F;border:2px solid #fff;box-shadow:0 1px 4px rgba(33,29,26,.5)"><span style="transform:rotate(45deg);color:#fff;font:700 12px/1 system-ui,sans-serif">${initial}</span></span>`,
        iconSize: [26, 26],
        iconAnchor: [13, 26],
      });
      const marker = L.marker([f.lat, f.lng], { icon, title: f.name });
      marker.on("click", () => router.push(`/u/${f.handle ?? f.id}`));
      marker.addTo(layer);
      points.push([f.lat, f.lng]);
    }

    if (points.length > 1) {
      map.fitBounds(points, { padding: [30, 30], maxZoom: 16 });
    } else {
      map.setView(points[0]!, 14);
    }
  }

  // Create the map once (client-only).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const mod = await import("leaflet");
      const L = (mod.default ?? mod) as typeof Leaflet;
      if (cancelled || !containerRef.current || mapRef.current) return;
      leafletRef.current = L;
      const map = L.map(containerRef.current).setView([meRef.current.lat, meRef.current.lng], 14);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: tv("attribution"),
      }).addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      renderMarkers();
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
    // Init once; friend/centre updates are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw pins + refit when the friend set or the caller's position changes.
  useEffect(() => {
    renderMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friends, me.lat, me.lng]);

  return <div ref={containerRef} className={className} aria-label={t("mapAria")} role="img" />;
}
