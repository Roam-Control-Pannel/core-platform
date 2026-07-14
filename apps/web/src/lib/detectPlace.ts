/**
 * detectPlaceFromIp — fetch the coarse, permission-free /api/geo guess and shape it as a Place
 * the switcher/Explore can use as the cold-start default. Returns null when the host provides no
 * geo (local dev / off-platform) or the response is malformed — the caller then keeps its fallback.
 *
 * source: "detected" marks this as an IP guess (not a user choice or precise GPS), so the UI can
 * still invite the visitor to share their precise location or pick a town.
 */
"use client";

import type { Place } from "../components/PlaceSwitcher";

export async function detectPlaceFromIp(): Promise<Place | null> {
  try {
    const res = await fetch("/api/geo", { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const d = (await res.json()) as {
      detected?: boolean; lat?: unknown; lng?: unknown; city?: unknown; country?: unknown;
    };
    if (!d?.detected || typeof d.lat !== "number" || typeof d.lng !== "number") return null;
    if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) return null;
    const city = typeof d.city === "string" && d.city.trim() ? d.city.trim() : null;
    const country = typeof d.country === "string" && d.country.trim() ? d.country.trim() : undefined;
    return {
      id: "ip-location",
      name: city ?? "Near you",
      ...(country ? { hint: country } : {}),
      lat: d.lat,
      lng: d.lng,
      source: "detected",
    };
  } catch {
    return null;
  }
}
