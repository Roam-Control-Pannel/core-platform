/**
 * POST /api/transit/plan — the browser's server-side hop to Translink Trip-Request.
 *
 * Sibling to /api/transit/nearby: the client POSTs { origin, destination, date?, time?, arriveBy? }
 * (each endpoint a { stopId } or a { lat, lng }) and this handler, holding the x-internal-call
 * secret and forwarding the browser IP, makes the trusted hop to the API's internalProcedure
 * transit.planTrip. The API never throws — outcomes are a `status` field — so we pass it back; a
 * transport failure degrades to a small error payload.
 *
 * runtime nodejs (server-only secret); force-dynamic (per-request).
 */
import { NextResponse } from "next/server";
import { makeInternalTrpcClient } from "../../../../lib/internalTrpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Place = { stopId: string } | { lat: number; lng: number };

function parsePlace(v: unknown): Place | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.stopId === "string" && o.stopId.length > 0) return { stopId: o.stopId };
  if (
    typeof o.lat === "number" && Number.isFinite(o.lat) && o.lat >= -90 && o.lat <= 90 &&
    typeof o.lng === "number" && Number.isFinite(o.lng) && o.lng >= -180 && o.lng <= 180
  ) {
    return { lat: o.lat, lng: o.lng };
  }
  return null;
}

interface PlanInput {
  origin: Place;
  destination: Place;
  date?: string;
  time?: string;
  arriveBy?: boolean;
}

function parse(body: unknown): { ok: true; input: PlanInput } | { ok: false; reason: string } {
  if (typeof body !== "object" || body === null) return { ok: false, reason: "Body must be a JSON object." };
  const b = body as Record<string, unknown>;
  const origin = parsePlace(b.origin);
  const destination = parsePlace(b.destination);
  if (!origin) return { ok: false, reason: "`origin` must be { stopId } or { lat, lng }." };
  if (!destination) return { ok: false, reason: "`destination` must be { stopId } or { lat, lng }." };
  const input: PlanInput = { origin, destination };
  if (b.date !== undefined) {
    if (typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return { ok: false, reason: "`date` must be YYYY-MM-DD." };
    input.date = b.date;
  }
  if (b.time !== undefined) {
    if (typeof b.time !== "string" || !/^\d{2}:\d{2}$/.test(b.time)) return { ok: false, reason: "`time` must be HH:MM." };
    input.time = b.time;
  }
  if (b.arriveBy !== undefined) {
    if (typeof b.arriveBy !== "boolean") return { ok: false, reason: "`arriveBy` must be a boolean." };
    input.arriveBy = b.arriveBy;
  }
  return { ok: true, input };
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

function clientIpFrom(request: Request): string | null {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || null;
}

const errorPayload = {
  status: "error",
  trips: [],
  alerts: [],
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
  const parsed = parse(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid request.", detail: parsed.reason }, { status: 400 });
  }
  try {
    const trpc = makeInternalTrpcClient(clientIpFrom(request));
    const result = await trpc.transit.planTrip.query(parsed.input);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("[api/transit/plan] planTrip failed:", err);
    return NextResponse.json(errorPayload, { status: 200 });
  }
}
