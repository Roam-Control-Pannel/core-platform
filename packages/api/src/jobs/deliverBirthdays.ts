/**
 * Birthday delivery job — the Node runner behind birthday engine v2-B (web push).
 *
 * WHY A NODE JOB (not the DB cron): the grant + the in-app notification are pure SQL, so
 * deliver_birthday_offers() writes those DB-side. But a WEB PUSH needs a signed VAPID JWT and an
 * https socket (web-push, Node-only) AND a credit charge (the append-only ledger in @roam/core) —
 * neither of which Postgres can do. So the delivery is split: the SQL function does the atomic
 * grant and RETURNS who was granted; this job takes those rows and layers the paid push on top,
 * reusing the exact machinery the follower-push path uses (pushToProfileIds + credits.*). Migration
 * 0055 unschedules the old DB-side cron so THIS is the sole caller — otherwise the cron would
 * consume the day's grants (on conflict do nothing) and leave the job nothing to push.
 *
 * THE MODEL (the slice decision): the in-app notification is FREE and always lands (the function
 * already wrote it). The web push is the paid upgrade — 1 credit per pushed RECIPIENT, and only to
 * push_ok recipients (the follow's push_enabled). Per venue we push to at most `balance` recipients
 * (engaged-first ordering is already applied by the function), consuming exactly that many credits
 * in one ledger entry. A venue with no balance simply doesn't push — its followers still got the
 * free in-app treat. One credit is never spent without an attempted push, and a push is never sent
 * without a credit (consume happens first; if a concurrent send drained the balance the consume
 * fails and we skip — safe direction).
 *
 * RUNNABLE ENTRY: at the bottom, guarded so importing this module for its functions doesn't run it.
 * Railway cron invokes `pnpm --filter @roam/api deliver-birthdays` daily; env arrives from the host
 * (same vars server.ts fail-fasts on). Exits non-zero on a catastrophic failure so a failed run is
 * visible in Railway's cron history.
 */
import { createServiceClient, type RoamClient } from "@roam/db";
import { credits, routes } from "@roam/core";
import { pushToProfileIds, type VapidConfig } from "../push/dispatch.js";

/** One freshly-granted birthday row, as returned by deliver_birthday_offers(). */
interface DeliveryRow {
  user_id: string;
  venue_id: string;
  venue_name: string | null;
  title: string | null;
  code: string | null;
  push_ok: boolean;
}

/** Run-summary tally — logged so a Railway cron run is auditable at a glance. */
export interface BirthdayJobResult {
  /** Total NEW grants delivered (in-app notifications that landed — free). */
  delivered: number;
  /** Distinct venues that delivered at least one grant today. */
  venues: number;
  /** Recipients eligible for a push (push_ok) across all venues. */
  pushEligible: number;
  /** Recipients we actually charged + attempted a push for (balance-capped). */
  pushCharged: number;
  /** Web pushes the service accepted (may differ from pushCharged: 0/multiple devices per person). */
  pushSent: number;
  /** Credits consumed across all venues (== pushCharged). */
  creditsSpent: number;
  /** Venues whose push was skipped entirely for want of credit. */
  venuesNoCredit: number;
}

/** rpc widened: deliver_birthday_offers() isn't in the generated DB types. Same idiom as the routers. */
type LooseRpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

/**
 * Deliver today's birthday treats: call the SQL grant (which writes the free in-app notifications
 * and returns who was granted), then push the push_ok recipients per venue up to that venue's
 * credit balance, consuming one credit each. Pure orchestration over injected collaborators (the
 * service client + vapid) — no env reading, so it's callable from the runner or a test.
 */
export async function runBirthdayDelivery(
  service: RoamClient,
  vapid: VapidConfig,
  log: (msg: string) => void = () => {},
): Promise<BirthdayJobResult> {
  const rpc = service.rpc.bind(service) as unknown as LooseRpc;
  const { data, error } = await rpc("deliver_birthday_offers");
  if (error) {
    throw new Error(`deliver_birthday_offers failed: ${error.message}`);
  }
  const rows = (Array.isArray(data) ? data : []) as DeliveryRow[];

  const result: BirthdayJobResult = {
    delivered: rows.length,
    venues: 0,
    pushEligible: 0,
    pushCharged: 0,
    pushSent: 0,
    creditsSpent: 0,
    venuesNoCredit: 0,
  };
  if (rows.length === 0) {
    log("No birthdays to deliver today.");
    return result;
  }

  // Group grants by venue: credits are a per-venue resource, so the push budget is decided per venue.
  const byVenue = new Map<string, DeliveryRow[]>();
  for (const row of rows) {
    const list = byVenue.get(row.venue_id);
    if (list) list.push(row);
    else byVenue.set(row.venue_id, [row]);
  }
  result.venues = byVenue.size;

  for (const [venueId, venueRows] of byVenue) {
    const venueName = venueRows[0]?.venue_name ?? "a place you follow";
    // Only push_ok recipients are pushable; the rest keep just their (free) in-app treat.
    const pushable = venueRows.filter((r) => r.push_ok).map((r) => r.user_id);
    result.pushEligible += pushable.length;
    if (pushable.length === 0) continue;

    const balance = await credits.getBalance(service, venueId);
    if (balance <= 0) {
      result.venuesNoCredit += 1;
      log(`${venueName}: ${pushable.length} birthday push(es) skipped — no credit (in-app treat still sent).`);
      continue;
    }

    // Push to at most `balance` recipients (function already ordered engaged-first). Charge exactly
    // that many in one ledger entry BEFORE pushing — a push is never sent unpaid.
    const recipients = pushable.slice(0, balance);
    const consumed = await credits.consumeForSend(service, venueId, recipients.length, "birthday");
    if (!consumed.ok) {
      // A concurrent send drained the balance between the read and here — skip (safe direction).
      result.venuesNoCredit += 1;
      log(`${venueName}: birthday push skipped — balance changed under us (shortfall ${consumed.shortfall}).`);
      continue;
    }
    result.pushCharged += recipients.length;
    result.creditsSpent += recipients.length;

    const title = venueRows[0]?.title?.trim() || "Happy birthday! A treat for you 🎂";
    const dispatch = await pushToProfileIds(service, vapid, recipients, {
      venueId,
      url: routes.venuePath(venueId),
      title,
      body: `A birthday treat from ${venueName}. Tap to open your treats.`,
    });
    result.pushSent += dispatch.sent;
    log(
      `${venueName}: charged ${recipients.length} credit(s) for ${recipients.length} recipient(s) → ` +
        `${dispatch.sent} sent, ${dispatch.failed} failed, ${dispatch.pruned} pruned` +
        (pushable.length > recipients.length ? ` (${pushable.length - recipients.length} unfunded, in-app only)` : ""),
    );
  }

  return result;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `[@roam/api] Missing required env var ${name}. Refusing to run the birthday job. ` +
        `Populate it from the RoamLocal Core Project dashboard — never from a DDS key.`,
    );
  }
  return v;
}

/**
 * Runner: builds the real service client + vapid config from the host env, runs the delivery, logs
 * the tally, exits non-zero on failure. Guarded so importing this module (for runBirthdayDelivery /
 * BirthdayJobResult) never triggers a run — only a direct `tsx src/jobs/deliverBirthdays.ts` does.
 */
async function main(): Promise<void> {
  const service = createServiceClient({
    url: requireEnv("SUPABASE_URL"),
    serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  });
  const vapid: VapidConfig = {
    subject: requireEnv("VAPID_SUBJECT"),
    publicKey: requireEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY"),
    privateKey: requireEnv("VAPID_PRIVATE_KEY"),
  };

  console.log(`\n🎂 Birthday delivery — ${new Date().toISOString()}\n`);
  const r = await runBirthdayDelivery(service, vapid, (m) => console.log(`  ${m}`));
  console.log("\n──────── summary ────────");
  console.log(`grants delivered:   ${r.delivered}  (free in-app treats)`);
  console.log(`venues delivering:  ${r.venues}`);
  console.log(`push eligible:      ${r.pushEligible}`);
  console.log(`push charged:       ${r.pushCharged}  (${r.creditsSpent} credit(s))`);
  console.log(`push sent:          ${r.pushSent}`);
  console.log(`venues w/o credit:  ${r.venuesNoCredit}  (in-app only)`);
  console.log("─────────────────────────\n");
}

// tsx sets import.meta.url to the entry file's URL when run directly; the process.argv[1] check
// keeps this from firing when the module is merely imported.
const isDirectRun = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((e) => {
    console.error("\nBirthday delivery failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
