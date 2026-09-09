/**
 * Owner activity digest — the daily email to venue owners summarising new business activity.
 *
 * Owners get an in-app bell for every user action on their business (reviews, orders, comments,
 * claim decisions), but nothing pulls them back when they're not in the app. This job reads those
 * same `notifications` rows (the single source of truth — no new per-event hooks) and, once a day,
 * emails each owner a digest of what's new since we last emailed them.
 *
 * Shape (mirrors deliverBirthdays): a pure `runOwnerDigest(service, deps, log)` callable from the
 * runner or a test, plus a guarded `main()` that builds real deps from host env. Railway cron
 * invokes `pnpm --filter @roam/api deliver-owner-digest` daily; pg_cron can also POST the internal
 * /jobs/deliver-owner-digest route. Dormant (sends nothing) until Brevo sender + unsubscribe secret
 * are provisioned, so shipping it is safe.
 *
 * Idempotent within a day: a per-owner watermark (owner_digest_state.last_emailed_at) means a second
 * run the same day re-sends nothing. A 7-day hard floor bounds the scan and caps how far back a
 * missed run reaches.
 */
import { createServiceClient, type RoamClient } from "@roam/db";
import { sendTransactionalEmail, type EmailSender } from "../brevo/transactional.js";
import { renderOwnerDigestEmail, type DigestItem } from "../ownerDigest/render.js";
import { signOwnerToken } from "../ownerDigest/token.js";

/** The curated, high-signal owner notification types the digest includes. */
export const OWNER_DIGEST_TYPES = [
  "venue_review",
  "order_received",
  "business_post_comment",
  "claim_approved",
  "claim_rejected",
] as const;

const DAY_MS = 86_400_000;

export interface OwnerDigestDeps {
  brevoApiKey: string | null;
  sender: EmailSender;
  unsubscribeSecret: string | null;
  /** The web app origin — for the dashboard CTA and unsubscribe links, and to absolutise hrefs. */
  webOrigin: string;
}

export interface OwnerDigestResult {
  candidates: number; // owners with new activity in-window (pre opt-out)
  sent: number;
  failed: number;
  skippedOptOut: number;
  status: "ok" | "unconfigured";
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Loose = {
  from: (t: string) => any;
  auth: { admin: { getUserById: (id: string) => Promise<{ data: { user: { email?: string | null } | null } | null }> } };
};

interface NotifRow { id: string; recipient_id: string; type: string; payload: any; created_at: string }

/** Join a possibly-relative href to the web origin; pass absolute http(s) through unchanged. */
function absolute(webOrigin: string, href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  const base = webOrigin.replace(/\/+$/, "");
  return `${base}${href.startsWith("/") ? "" : "/"}${href}`;
}

export async function runOwnerDigest(
  service: RoamClient,
  deps: OwnerDigestDeps,
  log: (msg: string) => void = () => {},
): Promise<OwnerDigestResult> {
  const empty: OwnerDigestResult = { candidates: 0, sent: 0, failed: 0, skippedOptOut: 0, status: "unconfigured" };
  if (!deps.brevoApiKey || !deps.unsubscribeSecret) {
    log("Owner digest unconfigured (missing BREVO_API_KEY or OWNER_DIGEST_UNSUBSCRIBE_SECRET) — nothing sent.");
    return empty;
  }

  const db = service as unknown as Loose;
  const runStartIso = new Date().toISOString();
  const floorIso = new Date(Date.now() - 7 * DAY_MS).toISOString();

  // Read EVERY qualifying notification in the 7-day window, paging through in a stable
  // (created_at, id) order. The previous single `.limit(5000)` ascending scan returned only the
  // OLDEST 5000 rows platform-wide, so once weekly volume passed that cap every returned row
  // predated each owner's watermark → byRecipient empty → 0 sent, logged as a clean "ok" while
  // nobody got a digest. PAGE_SIZE stays within PostgREST's max-rows cap; MAX_PAGES is a safety
  // bound so a pathological week can't loop unboundedly.
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 200;
  const notifs: NotifRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error: notifErr } = await db
      .from("notifications")
      .select("id, recipient_id, type, payload, created_at")
      .in("type", OWNER_DIGEST_TYPES as unknown as string[])
      .gte("created_at", floorIso)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (notifErr) throw new Error(`owner digest: notifications read failed: ${notifErr.message}`);
    const rows = (data ?? []) as NotifRow[];
    notifs.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    if (page === MAX_PAGES - 1) {
      log(`owner digest: hit the ${MAX_PAGES}-page scan cap (${MAX_PAGES * PAGE_SIZE} rows) — window may be truncated.`);
    }
  }
  if (notifs.length === 0) {
    log("No owner activity in the last 7 days.");
    return { candidates: 0, sent: 0, failed: 0, skippedOptOut: 0, status: "ok" };
  }

  const recipientIds = [...new Set(notifs.map((n) => n.recipient_id))];
  const { data: states } = await db.from("owner_digest_state").select("owner_id, last_emailed_at");
  const watermark = new Map<string, string>((states ?? []).map((s: any) => [s.owner_id, s.last_emailed_at]));

  const { data: profs } = await db
    .from("profiles")
    .select("id, display_name, owner_digest_opt_out")
    .in("id", recipientIds);
  const optOut = new Map<string, boolean>((profs ?? []).map((p: any) => [p.id, !!p.owner_digest_opt_out]));
  const firstName = new Map<string, string | null>(
    (profs ?? []).map((p: any) => [p.id, typeof p.display_name === "string" ? p.display_name.trim().split(/\s+/)[0] || null : null]),
  );

  // Group new-since-watermark items per owner.
  const byRecipient = new Map<string, DigestItem[]>();
  for (const n of notifs) {
    if (optOut.get(n.recipient_id)) continue; // opted-out owners tallied below via the distinct set
    const wm = watermark.get(n.recipient_id) ?? floorIso;
    if (n.created_at <= wm) continue;
    const text = typeof n.payload?.text === "string" ? n.payload.text : null;
    if (!text) continue;
    const href = typeof n.payload?.href === "string" ? n.payload.href : null;
    const item: DigestItem = { text, url: href ? absolute(deps.webOrigin, href) : null };
    const arr = byRecipient.get(n.recipient_id) ?? [];
    arr.push(item);
    byRecipient.set(n.recipient_id, arr);
  }
  // Distinct opted-out owners who had in-window activity (for the tally).
  const skippedOptOut = new Set(notifs.filter((n) => optOut.get(n.recipient_id)).map((n) => n.recipient_id)).size;

  const base = deps.webOrigin.replace(/\/+$/, "");
  let sent = 0;
  let failed = 0;
  const sentOwners: string[] = [];

  for (const [ownerId, items] of byRecipient) {
    if (items.length === 0) continue;
    const { data: authData } = await db.auth.admin.getUserById(ownerId);
    const email = authData?.user?.email ?? null;
    if (!email) {
      log(`owner ${ownerId}: no email on file — skipped.`);
      continue;
    }
    const token = signOwnerToken(ownerId, deps.unsubscribeSecret);
    const rendered = renderOwnerDigestEmail({
      ownerFirstName: firstName.get(ownerId) ?? null,
      items,
      dashboardUrl: `${base}/dashboard`,
      unsubscribeUrl: `${base}/unsubscribe/owner-digest?token=${encodeURIComponent(token)}`,
    });
    const ok = await sendTransactionalEmail(deps.brevoApiKey, deps.sender, {
      toEmail: email,
      subject: rendered.subject,
      htmlContent: rendered.html,
      textContent: rendered.text,
    });
    if (ok) {
      sent += 1;
      sentOwners.push(ownerId);
    } else {
      failed += 1;
    }
  }

  // Advance the watermark only for owners we actually emailed, so a failed send retries next run.
  if (sentOwners.length > 0) {
    const nowIso = new Date().toISOString();
    await db
      .from("owner_digest_state")
      .upsert(
        sentOwners.map((owner_id) => ({ owner_id, last_emailed_at: runStartIso, updated_at: nowIso })),
        { onConflict: "owner_id" },
      );
  }

  log(`Owner digest: ${sent} sent, ${failed} failed, ${skippedOptOut} opted out.`);
  return { candidates: byRecipient.size, sent, failed, skippedOptOut, status: "ok" };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const service = createServiceClient({
    url: requireEnv("SUPABASE_URL"),
    serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  });
  const deps: OwnerDigestDeps = {
    brevoApiKey: process.env.BREVO_API_KEY ?? null,
    sender: {
      email: process.env.BREVO_SENDER_EMAIL ?? "no-reply@roam-local.com",
      name: process.env.BREVO_SENDER_NAME ?? "Roam",
    },
    unsubscribeSecret: process.env.OWNER_DIGEST_UNSUBSCRIBE_SECRET ?? null,
    webOrigin:
      process.env.WEB_ORIGIN ??
      (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:3000").split(",")[0]!.trim(),
  };

  console.log(`\n📧 Owner digest — ${new Date().toISOString()}\n`);
  const r = await runOwnerDigest(service, deps, (m) => console.log(`  ${m}`));
  console.log("\n──────── summary ────────");
  console.log(`status:        ${r.status}`);
  console.log(`candidates:    ${r.candidates}`);
  console.log(`emails sent:   ${r.sent}`);
  console.log(`send failures: ${r.failed}`);
  console.log(`opted out:     ${r.skippedOptOut}`);
  console.log("─────────────────────────\n");
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((e) => {
    console.error("\nOwner digest failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
