/**
 * VenueMap — an interactive map of the venues currently shown in Explore, with a pin per
 * venue (click → its page). Roam doesn't pay for a map provider: this uses Leaflet (MIT,
 * open-source) over free OpenStreetMap tiles — no SDK key, no billing. Get Directions and
 * "Open in Maps" still hand off to the device's default maps app (see lib/directions).
 *
 * Leaflet touches window/document, so it's imported DYNAMICALLY inside an effect — never at
 * module load — so SSR / `next build` never evaluate it on the server. Pins are custom
 * divIcons (a small teardrop), which sidesteps Leaflet's default-marker image paths that
 * break under bundlers. The map is created once; a second effect re-draws markers and
 * re-centres when the place or the venue set changes.
 */
"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import { venuePath } from "../lib/routes";

export interface MapVenue {
  id: string;
  name: string;
  lat: number;
  lng: number;
  claimed: boolean;
}

export function VenueMap({
  venues,
  center,
  className,
}: {
  venues: MapVenue[];
  center: { lat: number; lng: number };
  className?: string | undefined;
}) {
  const t = useTranslations("venueMap");
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const layerRef = useRef<Leaflet.LayerGroup | null>(null);
  const leafletRef = useRef<typeof Leaflet | null>(null);
  const router = useRouter();

  // Draw (or redraw) the pins for the current venue set. No-op until the map is ready.
  function renderMarkers() {
    const L = leafletRef.current;
    const layer = layerRef.current;
    const map = mapRef.current;
    if (!L || !layer || !map) return;
    layer.clearLayers();
    const points: [number, number][] = [];
    for (const v of venues) {
      if (typeof v.lat !== "number" || typeof v.lng !== "number") continue;
      const colour = v.claimed ? "#C2123F" : "#9D0F33";
      const icon = L.divIcon({
        className: "",
        html: `<span style="display:block;width:16px;height:16px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${colour};border:2px solid #fff;box-shadow:0 1px 3px rgba(33,29,26,.45)"></span>`,
        iconSize: [16, 16],
        iconAnchor: [8, 16],
      });
      const marker = L.marker([v.lat, v.lng], { icon, title: v.name });
      marker.on("click", () => router.push(venuePath(v.id)));
      marker.addTo(layer);
      points.push([v.lat, v.lng]);
    }
    if (points.length > 1) {
      map.fitBounds(points, { padding: [26, 26], maxZoom: 16 });
    } else if (points.length === 1) {
      map.setView(points[0]!, 15);
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
      const map = L.map(containerRef.current).setView([center.lat, center.lng], 14);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: t("attribution"),
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
    // Init once; later updates are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-centre when the place changes.
  useEffect(() => {
    const map = mapRef.current;
    if (map) map.setView([center.lat, center.lng], map.getZoom());
  }, [center.lat, center.lng]);

  // Re-draw pins when the shown venue set changes.
  useEffect(() => {
    renderMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venues]);

  return <div ref={containerRef} className={className} aria-label={t("ariaLabel")} role="img" />;
}
