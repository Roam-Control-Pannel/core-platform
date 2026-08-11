/**
 * POST /api/ingest-food-to-go — the Food to Go storefront's open-mode supply trigger.
 *
 * Sibling to /api/ingest-area, but it pulls FOOD-TO-GO venues specifically (cafés, coffee shops,
 * bakeries, fast food) rather than the coarse starter categories. The storefront POSTs { lat, lng }
 * here only when it has zero food-to-go venues near the point; this server-side handler (holding
 * the x-internal-call secret via internalTrpc) makes the trusted hop to places.ingestFoodToGo,
 * which asks Places for food-to-go types directly under the same budget + rate-limit guards.
 * Shape-only validation here; the cost controls live at the API boundary.
 *
 * runtime nodejs (reads a server-only secret + outbound fetch); force-dynamic (per-request action).
 */
import { NextResponse } from "next/server";
import { makeInternalTrpcClient } from "../../../lib/internalTrpc";

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
    const result = await trpc.places.ingestFoodToGo.mutate({ lat: parsed.lat, lng: parsed.lng });
    if (result.reason === "budget-exhausted" || result.reason === "rate-limited") {
      console.warn(`[api/ingest-food-to-go] supply gated for ip=${clientIpFrom(request) ?? "unknown"}`);
    }
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("[api/ingest-food-to-go] ingestFoodToGo failed:", err);
    return NextResponse.json({ error: "Food-to-go discovery failed. Please try again." }, { status: 502 });
  }
}
