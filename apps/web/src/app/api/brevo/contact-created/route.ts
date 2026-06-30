/**
 * POST /api/brevo/contact-created — the new-user → Brevo-list webhook receiver.
 *
 * A Supabase Database Webhook on `public.profiles` INSERT calls this route on every signup
 * (a profiles row is provisioned for each new auth user by the 0006 trigger). The webhook is
 * authenticated by a shared secret header (BREVO_WEBHOOK_SECRET) — NOT public. This route then
 * makes the trusted internal hop (x-internal-call secret, via makeInternalTrpcClient) to
 * marketing.syncNewUser, which looks up the email and adds the user to the new-users list.
 *
 * Best-effort by design: a malformed/duplicate event or a downstream failure returns 200 so
 * Supabase doesn't spin on retries — the marketing side effect must never wedge signups.
 *
 * runtime nodejs (reads a server-only secret + outbound fetch); force-dynamic (per-request).
 */
import { NextResponse } from "next/server";
import { makeInternalTrpcClient } from "../../../../lib/internalTrpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Extract the new profile id from a Supabase webhook payload ({ type, table, record, ... }). */
function profileIdFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = (body as { record?: unknown }).record;
  if (typeof record !== "object" || record === null) return null;
  const id = (record as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.BREVO_WEBHOOK_SECRET;
  if (!expected) {
    console.error("[api/brevo/contact-created] BREVO_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "Not configured." }, { status: 503 });
  }
  if (request.headers.get("x-webhook-secret") !== expected) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const profileId = profileIdFrom(body);
  if (!profileId) {
    // Not a shape we act on (e.g. a non-INSERT event) — ack so Supabase doesn't retry.
    return NextResponse.json({ ok: true, skipped: true }, { status: 200 });
  }

  try {
    const trpc = makeInternalTrpcClient(null);
    const result = await trpc.marketing.syncNewUser.mutate({ profileId });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    // Ack with 200: a failed sync must not block signups or trigger webhook retry storms.
    console.error("[api/brevo/contact-created] syncNewUser failed:", err);
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
