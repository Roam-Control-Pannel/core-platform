/**
 * POST /api/transit/nearby — the browser's server-side hop to the NI departure board.
 *
 * Sibling to /api/ingest-area: the client POSTs { lat, lng } and this handler (holding the
 * x-internal-call secret via makeInternalTrpcClient, and forwarding the browser IP as the
 * client key) makes the trusted hop to the API's internalProcedure transit.nearbyDepartures.
 * The browser can't reach that internal surface directly — which is the point, because Translink
 * is a fair-use-limited API and the per-client throttle keys off the forwarded IP.
 *
 * The API never throws for this call — every outcome is a `status` field on the board — so we
 * just pass the board straight back. A transport failure to the API itself degrades to a small
 * error board so the card can render "couldn't load" rather than the route 500ing.
 *
 * runtime nodejs (reads a server-only secret); force-dynamic (per-request, location-specific).
 */
import { NextResponse } from "next/server";
import { makeInternalTrpcClient } from "../../../../lib/internalTrpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parse(body: unknown): { ok: true; lat: number; lng: number } | { ok: false; reason: string } {
  if (typeof body !== "object" || body === null) return { ok: false, reason: "Body must be a JSON object." };
  const b = body as Record<string, unknown>;
  if (typeof b.lat !== "number" || Number.isNaN(b.lat) || b.lat < -90 || b.lat > 90) {
    return { ok: false, reason: "`lat` must be a number between -90 and 90." };
  }
  if (typeof b.lng !== "number" || Number.isNaN(b.lng) || b.lng < -180 || b.lng > 180) {
    return { ok: false, reason: "`lng` must be a number between -180 and 180." };
  }
  return { ok: true, lat: b.lat, lng: b.lng };
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
    const board = await trpc.transit.nearbyDepartures.query({ lat: parsed.lat, lng: parsed.lng });
    return NextResponse.json(board, { status: 200 });
  } catch (err) {
    console.error("[api/transit/nearby] nearbyDepartures failed:", err);
    return NextResponse.json(
      {
        status: "error",
        stop: null,
        departures: [],
        attribution: "Transport Information supplied by Translink Opendata API",
        cached: false,
      },
      { status: 200 },
    );
  }
}
