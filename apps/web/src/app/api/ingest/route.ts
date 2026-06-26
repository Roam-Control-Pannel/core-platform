/**
 * POST /api/ingest — the server-side gated trigger for on-demand venue supply.
 *
 * WHY THIS EXISTS: the API's places.ingestCategory is an internalProcedure — it needs
 * the x-internal-call secret and triggers PAID Google Places calls, so it must never be
 * reachable directly from the browser. This Route Handler is the browser's only door to
 * it: the client POSTs { category, lat, lng } here; this handler (server-side, holding
 * the secret via internalTrpc) makes the trusted server-to-server hop to the API. The
 * secret lives only in the Node runtime — never in the client bundle (see internalTrpc).
 *
 * VALIDATION SPLIT (single source of truth): this handler validates SHAPE only —
 * category is a non-empty string, lat/lng are real and in range. It does NOT re-encode
 * the nine-category enum: that list lives once in @roam/core and is enforced at the API
 * boundary (places.ingestCategory's Zod categoryEnum). Forwarding an unknown category
 * gets a clean rejection from the API, which we surface. Duplicating the enum here would
 * invite exactly the taxonomy drift core's single-definition design prevents.
 *
 * runtime: nodejs — this handler reads a server-only secret and makes an outbound fetch;
 * it must run in the Node runtime, not the edge sandbox. force-dynamic: it is a pure
 * per-request action with no cacheable output.
 */
import { NextResponse } from "next/server";
import { makeInternalTrpcClient } from "../../../lib/internalTrpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The validated shape forwarded to the API. */
interface IngestInput {
  category: string;
  lat: number;
  lng: number;
}

/**
 * Shape-only validation in plain TS — zod is not a @roam/web dependency, and adding it
 * for three field checks is the wrong trade. Membership of `category` against the nine
 * canonical groups is enforced at the API boundary (places.ingestCategory), the single
 * source of truth; here we only guarantee the fields exist and the numbers are sane.
 * Returns the typed value on success, or a human-readable reason on failure.
 */
function parseIngestInput(body: unknown): { ok: true; value: IngestInput } | { ok: false; reason: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "Body must be a JSON object." };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.category !== "string" || b.category.length === 0) {
    return { ok: false, reason: "`category` must be a non-empty string." };
  }
  if (typeof b.lat !== "number" || Number.isNaN(b.lat) || b.lat < -90 || b.lat > 90) {
    return { ok: false, reason: "`lat` must be a number between -90 and 90." };
  }
  if (typeof b.lng !== "number" || Number.isNaN(b.lng) || b.lng < -180 || b.lng > 180) {
    return { ok: false, reason: "`lng` must be a number between -180 and 180." };
  }
  return { ok: true, value: { category: b.category, lat: b.lat, lng: b.lng } };
}

/**
 * The browser's IP, as seen at the edge. Vercel/Railway set x-forwarded-for (client first,
 * proxies appended); x-real-ip is the single-value fallback. Used only as the per-client
 * rate-limit key — null when absent (then only the global budget applies).
 */
function clientIpFrom(request: Request): string | null {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || null;
}

/**
 * Cheap same-origin guard: reject a cross-origin browser POST. This isn't the real cost
 * control (a scripted client sets no Origin / a fake one — that's what the budget + rate
 * limit are for), but it filters casual cross-site abuse for free. Only rejects when an
 * Origin is present AND its host disagrees with the request host; absent Origin is allowed.
 */
function isCrossOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true; // an unparseable Origin is not a same-origin request
  }
}

export async function POST(request: Request): Promise<Response> {
  if (isCrossOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  }

  // Parse + shape-validate the body. A malformed body is the caller's error (400).
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const parsed = parseIngestInput(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "Invalid ingest request.", detail: parsed.reason },
      { status: 400 },
    );
  }

  // The trusted hop. internalTrpc attaches x-internal-call; the API enforces the secret,
  // validates the category against the canonical enum, runs the cost-controlled ingest,
  // and returns the tally (skipped | no-matching-places | ingested).
  try {
    const trpc = makeInternalTrpcClient(clientIpFrom(request));
    const result = await trpc.places.ingestCategory.mutate({
      category: parsed.value.category,
      lat: parsed.value.lat,
      lng: parsed.value.lng,
    });
    // Surface a gated supply request server-side so abuse / budget exhaustion is visible
    // (no silent caps). The response itself is unchanged — the caller reads existing supply.
    if (result.reason === "budget-exhausted" || result.reason === "rate-limited") {
      console.warn(`[api/ingest] supply gated (${result.reason}) for ip=${clientIpFrom(request) ?? "unknown"}`);
    }
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    // The API surfaced an error (bad category, upstream Places failure, or a missing
    // secret on our side). Log server-side; return a generic 502 so we never leak
    // internal detail or the secret to the browser.
    console.error("[api/ingest] ingestCategory failed:", err);
    return NextResponse.json(
      { error: "Venue ingestion failed. Please try again." },
      { status: 502 },
    );
  }
}
