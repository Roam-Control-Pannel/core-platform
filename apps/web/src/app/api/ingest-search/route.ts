/**
 * POST /api/ingest-search — the demand-driven "find this venue by name" trigger.
 *
 * Sibling to /api/ingest-area: when the Explore search box finds nothing in the venues already
 * loaded, the client POSTs { q, lat, lng } here and this server-side handler (holding the
 * x-internal-call secret via internalTrpc) makes the trusted hop to places.searchText. That
 * procedure is DB-first (a venue already stored, or a repeat search, returns free) and only pays
 * for a Google Places Text Search when the DB has no name match — under the same budget +
 * per-client rate guards as the other ingest paths. Returns the matched venue cards.
 *
 * runtime nodejs (reads a server-only secret + outbound fetch); force-dynamic (per-request action).
 */
import { NextResponse } from "next/server";
import { makeInternalTrpcClient } from "../../../lib/internalTrpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parse(body: unknown): { ok: true; q: string; lat: number; lng: number } | { ok: false; reason: string } {
  if (typeof body !== "object" || body === null) return { ok: false, reason: "Body must be a JSON object." };
  const b = body as Record<string, unknown>;
  const q = typeof b.q === "string" ? b.q.trim() : "";
  if (q.length < 2 || q.length > 120) return { ok: false, reason: "`q` must be 2–120 characters." };
  if (typeof b.lat !== "number" || Number.isNaN(b.lat) || b.lat < -90 || b.lat > 90) {
    return { ok: false, reason: "`lat` must be a number between -90 and 90." };
  }
  if (typeof b.lng !== "number" || Number.isNaN(b.lng) || b.lng < -180 || b.lng > 180) {
    return { ok: false, reason: "`lng` must be a number between -180 and 180." };
  }
  return { ok: true, q, lat: b.lat, lng: b.lng };
}

function clientIpFrom(request: Request): string | null {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || null;
}

function isCrossOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (isCrossOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const parsed = parse(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid request.", detail: parsed.reason }, { status: 400 });
  }
  try {
    const trpc = makeInternalTrpcClient(clientIpFrom(request));
    const result = await trpc.places.searchText.mutate({ q: parsed.q, lat: parsed.lat, lng: parsed.lng });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("[api/ingest-search] searchText failed:", err);
    return NextResponse.json({ error: "Search failed. Please try again.", venues: [] }, { status: 502 });
  }
}
