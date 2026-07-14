/**
 * GET /api/geo — a coarse, PERMISSION-FREE guess of the visitor's location, read from the host's
 * edge geo headers (no external API, no cost, no prompt). Powers the first-visit default so a
 * brand-new signed-out visitor opens Explore near WHERE THEY ARE instead of a hard-coded town.
 *
 * Host-agnostic: reads Vercel's `x-vercel-ip-*` headers and Netlify's base64 `x-nf-geo` blob,
 * whichever is present. Off-platform (local dev, another host) there are no headers, so it
 * returns { detected: false } and the client falls back gracefully.
 *
 * This is a GUESS (IP → city, can be a data-centre/VPN), so it never overrides a stored choice or
 * precise geolocation — it's only the cold-start default. No IP is stored or logged here.
 *
 * runtime nodejs (Buffer for the Netlify base64); force-dynamic + no-store (per-request, per-IP).
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function num(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= -180 && n <= 180 ? n : null;
}

type Geo = { detected: true; lat: number; lng: number; city: string | null; country: string | null } | { detected: false };

function readGeo(headers: Headers): Geo {
  // Vercel edge geo (city is percent-encoded; lat/lng are strings).
  let lat = num(headers.get("x-vercel-ip-latitude"));
  let lng = num(headers.get("x-vercel-ip-longitude"));
  let city = headers.get("x-vercel-ip-city");
  let country = headers.get("x-vercel-ip-country");

  // Netlify geo (base64-encoded JSON): { city, country: { code }, subdivision, latitude, longitude }.
  if (lat == null || lng == null) {
    const nf = headers.get("x-nf-geo");
    if (nf) {
      try {
        const g = JSON.parse(Buffer.from(nf, "base64").toString("utf8")) as {
          city?: string; country?: { code?: string }; latitude?: number; longitude?: number;
        };
        lat = lat ?? num(g.latitude != null ? String(g.latitude) : null);
        lng = lng ?? num(g.longitude != null ? String(g.longitude) : null);
        city = city ?? g.city ?? null;
        country = country ?? g.country?.code ?? null;
      } catch {
        /* malformed header — treat as undetected */
      }
    }
  }

  if (lat == null || lng == null || (lat === 0 && lng === 0)) return { detected: false };
  const decodedCity = city ? (() => { try { return decodeURIComponent(city); } catch { return city; } })() : null;
  return { detected: true, lat, lng, city: decodedCity, country: country ?? null };
}

export function GET(request: Request) {
  return NextResponse.json(readGeo(request.headers), { headers: { "cache-control": "no-store" } });
}
