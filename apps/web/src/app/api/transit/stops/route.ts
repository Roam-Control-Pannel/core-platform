/**
 * POST /api/transit/stops — the browser's server-side hop to Translink Stop-Finder.
 *
 * Sibling to /api/transit/nearby: the client POSTs { q } (a typed place name) and this handler,
 * holding the x-internal-call secret and forwarding the browser IP as the client key, makes the
 * trusted hop to the API's internalProcedure transit.searchStops. Powers the journey-planner
 * from/to autocomplete. The API never throws — every outcome is a `status` on the payload — so we
 * pass it straight back; a transport failure degrades to a small error payload.
 *
 * runtime nodejs (reads a server-only secret); force-dynamic (per-request).
 */
import { NextResponse } from "next/server";
import { makeInternalTrpcClient } from "../../../../lib/internalTrpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

const errorPayload = {
  status: "error",
  matches: [],
  attribution: "Transport Information supplied by Translink Opendata API",
  cached: false,
};

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
  const q = typeof body === "object" && body !== null ? (body as Record<string, unknown>).q : undefined;
  if (typeof q !== "string" || q.trim().length < 2) {
    return NextResponse.json({ error: "`q` must be a string of at least 2 characters." }, { status: 400 });
  }
  try {
    const trpc = makeInternalTrpcClient(clientIpFrom(request));
    const result = await trpc.transit.searchStops.query({ q: q.trim().slice(0, 80) });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("[api/transit/stops] searchStops failed:", err);
    return NextResponse.json(errorPayload, { status: 200 });
  }
}
