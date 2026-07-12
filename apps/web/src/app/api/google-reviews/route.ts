/**
 * POST /api/google-reviews — fetch a venue's up-to-5 Google reviews for read-only display.
 *
 * Sibling to /api/enrich-venue: when a user asks to see Google reviews on a venue profile, the
 * client POSTs { venueId } here and this server-side handler (holding the x-internal-call secret
 * via internalTrpc) makes the trusted hop to places.googleReviews. That procedure gates to
 * Google-sourced venues, pays for at most one Place Details call — under the shared Details budget
 * + a 12h process cache — and returns the reviews plus the write-a-review deep link. Review
 * content is never persisted (Google Maps Platform terms); it is shown fresh, with attribution.
 *
 * runtime nodejs (reads a server-only secret + outbound fetch); force-dynamic (per-request action).
 */
import { NextResponse } from "next/server";
import { makeInternalTrpcClient } from "../../../lib/internalTrpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const venueId = typeof (body as { venueId?: unknown })?.venueId === "string" ? (body as { venueId: string }).venueId : "";
  if (!UUID_RE.test(venueId)) {
    return NextResponse.json({ error: "`venueId` must be a venue UUID." }, { status: 400 });
  }
  try {
    const trpc = makeInternalTrpcClient(clientIpFrom(request));
    const result = await trpc.places.googleReviews.query({ venueId });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("[api/google-reviews] googleReviews failed:", err);
    return NextResponse.json({ available: false, reviews: [], writeReviewUrl: null, googleMapsUri: null }, { status: 502 });
  }
}
