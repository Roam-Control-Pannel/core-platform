#!/usr/bin/env node
/**
 * check-schema-drift — fail loudly when the LIVE database is missing schema the deployed app needs.
 *
 * WHY THIS EXISTS (the Sep 2026 F2G storefront blackout): the CI `db` gate only validates an
 * ephemeral, freshly-reset local Postgres — it never checks that the *live* database has the
 * migrations applied that the *deployed app* requires. Migration 0134 added channels.nav/sections/
 * surface and the app started selecting them, but the live DB hadn't had 0134 applied (its migration
 * ledger even under-reported the real state), so every channel read threw and the storefront went
 * blank while the data was perfectly healthy. Nothing caught it until a user noticed.
 *
 * This guard reproduces the app's own read path against the live PostgREST endpoint and asserts the
 * critical columns actually resolve. It catches BOTH failure shapes:
 *   - 42703  (undefined_column)      — the migration isn't applied to this DB;
 *   - PGRST204 (schema cache)        — the column exists but PostgREST's cache is stale (the exact
 *                                      "applied the SQL but still broken" trap — needs a reload).
 * and, for the RPCs the app calls (holistic plan Phase 1.6):
 *   - PGRST202 (function not found)  — the function/signature isn't applied, or the cache is stale.
 * It is ledger-independent by design: it probes what the app actually reads, not schema_migrations
 * (which this project is known to under-report).
 *
 * Opt-in + safe: with SUPABASE_URL / SUPABASE_ANON_KEY unset it prints a skip notice (and a GitHub
 * Actions ::warning:: annotation when run in CI, so a silent skip is visible on the run) and exits 0,
 * so it never breaks a fork PR or an unconfigured repo. Configured, it exits non-zero on drift (or on
 * a connectivity/auth misconfig, with a distinct message) so a deploy/main run fails visibly.
 *
 * Run:  node scripts/check-schema-drift.mjs        (reads env SUPABASE_URL, SUPABASE_ANON_KEY)
 */

/**
 * The reads the deployed app depends on. Extend this as new required columns land — it is the living
 * contract between app code and the live schema. Each entry is probed as
 * `GET /rest/v1/<table>?select=<columns>&limit=1` as the anon role. A table the anon role cannot
 * read still answers 200 with `[]` (RLS filters rows, not columns), so RLS-locked tables are probed
 * exactly like public ones — only a MISSING column produces the drift shape.
 *
 * Keep each `columns` list to what the app actually selects (packages/core, packages/api, apps/web),
 * citing the migration that introduced it, so a failure names the migration to apply.
 */
export const REQUIRED_READS = [
  {
    table: "channels",
    columns: ["key", "surface", "sections", "nav", "membership_mode", "platform_fee_bps"],
    reason: "F2G storefront chrome + open-mode venue query + per-channel fee (migrations 0122, 0134, 0149)",
  },
  {
    table: "channel_domains",
    columns: ["host", "channel_id"],
    reason: "host → channel resolution in the web middleware (migration 0116)",
  },
  {
    table: "venue_channels",
    columns: ["venue_id", "channel_id"],
    reason: "curated-mode storefront + order channel tag lookup (migration 0116)",
  },
  {
    table: "channel_members",
    columns: ["id", "channel_id", "status", "membership_ref", "venue_id", "source_council", "claimed_by", "lapsed_at"],
    reason: "membership spine: roster, matching, HQ status actions, lapse stamp (migrations 0135, 0139, 0150)",
  },
  {
    table: "external_refs",
    columns: ["id", "entity_type", "entity_id", "dataset", "external_id", "method"],
    reason: "roster ↔ venue / FSA match ledger (migration 0137)",
  },
  {
    table: "orgs",
    columns: ["id", "status", "moderation", "owner_id", "category"],
    reason: "supplier directory + HQ moderation queue (migration 0136, plan Phase 1.8)",
  },
  {
    table: "fsa_establishments",
    columns: ["fhrsid", "rating_value", "rating_key", "rating_date", "synced_at", "local_authority"],
    reason: "FSA hygiene badge on venue pages and cards (migration 0141)",
  },
  {
    table: "job_posts",
    columns: ["id", "channel_id", "status"],
    reason: "Association jobs board (migration 0142)",
  },
  {
    table: "orders",
    columns: ["id", "channel_id"],
    reason: "channel-stamped orders at the channel's fee (migration 0149)",
  },
];

/**
 * The RPCs the app calls, probed as `POST /rest/v1/rpc/<name>` with the arguments the app sends.
 * PGRST202 ("could not find the function … in the schema cache") is DRIFT — the exact signature is
 * not applied, or PostgREST's cache is stale. Any other answer proves the function resolves:
 *   - `expect: "ok"`     — a 2xx (the anon role is granted EXECUTE and the call is cheap/read-only);
 *   - `expect: "denied"` — a 401/403 with SQLSTATE 42501 (service-only function: anon is DENIED, which
 *                          is both proof it exists and proof migration 0149/0151's revoke is in force).
 * A `denied` probe that answers 2xx is reported as a HARDENING regression, not a pass.
 */
export const RPC_PROBES = [
  {
    name: "venues_food_to_go_near",
    args: { origin_lat: 54.5973, origin_lng: -5.9301, page_size: 1, page_offset: 0, filter_channel_id: null },
    expect: "ok",
    reason: "open-mode storefront discovery, 5-arg signature (migrations 0145, 0146)",
  },
  {
    name: "f2g_member_venue_ids",
    args: { p_channel_id: "00000000-0000-0000-0000-000000000000" },
    expect: "ok",
    reason: "member-priority ranking (migration 0145)",
  },
  {
    name: "channel_members_search",
    args: { p_channel_key: "f2g", p_query: null, p_council: null, p_lat: null, p_lng: null, p_radius_m: null, p_limit: 1, p_offset: 0 },
    expect: "ok",
    reason: "PII-safe members directory (migration 0144)",
  },
  {
    name: "order_channel_for_venue",
    args: { p_venue_id: "00000000-0000-0000-0000-000000000000" },
    expect: "denied",
    reason: "checkout fee resolution — service-only (migration 0149)",
  },
  {
    name: "claim_places_detail_quota",
    args: { p_client_key: "drift-probe", p_daily_cap: 0, p_client_cap: 0, p_client_window_secs: 1 },
    expect: "denied",
    reason: "Places details budget — service-only since 0151 (holistic plan Phase 1.7)",
  },
  // 0076's posture. On 2026-09-17 the live project answered `true` to has_function_privilege for both
  // of these — 0076 had never been applied there. These two stand for the whole 0076 set: a 2xx here
  // means the migration is missing live and the Places budget / venue upsert are client-callable.
  {
    name: "claim_places_fetch_quota",
    args: { p_client_key: "drift-probe", p_daily_cap: 0, p_client_cap: 0, p_client_window_secs: 1 },
    expect: "denied",
    reason: "Places search budget — service-only since 0076 §1",
  },
  {
    name: "upsert_place_venues",
    args: { places: [] },
    expect: "denied",
    reason: "Places ingest writer (SECURITY DEFINER) — service-only since 0076 §1",
  },
];

/** Classify a PostgREST response body as a drift error (missing column / stale schema cache). */
export function isDriftError(body) {
  const code = String(body?.code ?? "");
  if (code === "42703" || code === "PGRST204") return true;
  const msg = String(body?.message ?? "").toLowerCase();
  return msg.includes("schema cache") || (msg.includes("column") && msg.includes("does not exist"));
}

/** Classify an RPC response body as "the function/signature is not there" (PGRST202 or 42883). */
export function isMissingFunctionError(body) {
  const code = String(body?.code ?? "");
  if (code === "PGRST202" || code === "42883") return true;
  const msg = String(body?.message ?? "").toLowerCase();
  return msg.includes("could not find the function") || (msg.includes("function") && msg.includes("does not exist"));
}

/** Classify an RPC response body as "exists, but this role may not execute it" (SQLSTATE 42501). */
export function isPermissionDenied(body) {
  const code = String(body?.code ?? "");
  if (code === "42501") return true;
  const msg = String(body?.message ?? "").toLowerCase();
  return msg.includes("permission denied for");
}

/**
 * Which Postgres role a Supabase API key resolves to, from the key alone. A legacy key is a JWT whose
 * payload carries `role` ("anon" | "service_role"); a 2025-format key is prefixed `sb_publishable_`
 * (anon) or `sb_secret_` (service). Returns null when the shape is unrecognised.
 *
 * WHY: every `expect: "denied"` probe is only meaningful as the anon role. Run with the service-role
 * key, the guard would report every service-only function as client-callable (a service key bypasses
 * grants) — exactly what happened on the first live run (2026-09-17) — or, worse, pass everything and
 * certify nothing. So the key's role is checked BEFORE any probe, and a non-anon key aborts the run.
 */
export function keyRole(key) {
  if (typeof key !== "string") return null;
  if (key.startsWith("sb_publishable_")) return "anon";
  if (key.startsWith("sb_secret_")) return "service_role";
  const parts = key.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
      return typeof payload?.role === "string" ? payload.role : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function main() {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    const note =
      "check-schema-drift: SUPABASE_URL / SUPABASE_ANON_KEY not set — skipping (not configured). " +
      "Set both (repo/deploy secrets) to enable the live-schema drift guard.";
    console.log(note);
    // In CI a silent skip is the failure mode the guard exists to prevent — annotate the run.
    if (process.env.GITHUB_ACTIONS === "true") console.log(`::warning::${note}`);
    process.exit(0);
  }

  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  // ── Preflight: the key MUST be the anon key ──────────────────────────────────────────────────
  // (1) From the key's own shape/claims.
  const role = keyRole(key);
  if (role !== null && role !== "anon") {
    console.error(
      `check-schema-drift: SUPABASE_ANON_KEY is a "${role}" key, not the anon key. Refusing to run:\n` +
        "  the service-only probes are meaningless with elevated privileges, and a service key must not live\n" +
        "  in this secret. Replace it with the project's anon (public) key — Supabase → Settings → API.",
    );
    process.exit(1);
  }
  // (2) Behaviourally: places_fetch_quota has ALL revoked from anon (migration 0130), so an anon read
  //     must be denied. A 2xx here means the request is not running as anon, whatever the key looks like.
  try {
    const res = await fetch(`${url}/rest/v1/places_fetch_quota?select=bucket&limit=1`, { headers });
    const body = await res.json().catch(() => null);
    if (res.ok) {
      console.error(
        "check-schema-drift: the key can read places_fetch_quota, which anon cannot (migration 0130).\n" +
          "  This request is not running as the anon role — SUPABASE_ANON_KEY is the wrong key. Refusing to run.",
      );
      process.exit(1);
    }
    if (!isPermissionDenied(body) && !isDriftError(body)) {
      console.error(`check-schema-drift: preflight got an unexpected ${res.status} — ${body?.message ?? "unknown error"}`);
      process.exit(1);
    }
    console.log("  ✓ preflight — running as the anon role");
  } catch (e) {
    console.error(`check-schema-drift: could not reach PostgREST for the preflight (${e.message})`);
    process.exit(1);
  }

  const drifts = [];
  const errors = [];
  const regressions = [];

  for (const { table, columns, reason } of REQUIRED_READS) {
    const endpoint = `${url}/rest/v1/${table}?select=${columns.join(",")}&limit=1`;
    let res, body;
    try {
      res = await fetch(endpoint, { headers });
      body = await res.json().catch(() => null);
    } catch (e) {
      errors.push(`${table}: could not reach PostgREST (${e.message})`);
      continue;
    }
    if (res.ok) {
      console.log(`  ✓ ${table} (${columns.join(", ")}) — readable`);
      continue;
    }
    if (isDriftError(body)) {
      drifts.push({ kind: "read", table, columns, reason, code: body?.code, message: body?.message });
    } else {
      // Not a drift shape — a bad key, RLS, or transport problem. Surface it distinctly so the
      // operator fixes the config rather than mistaking it for a schema gap.
      errors.push(`${table}: unexpected ${res.status} response — ${body?.message ?? "unknown error"}`);
    }
  }

  for (const { name, args, expect, reason } of RPC_PROBES) {
    const endpoint = `${url}/rest/v1/rpc/${name}`;
    let res, body;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      body = await res.json().catch(() => null);
    } catch (e) {
      errors.push(`rpc/${name}: could not reach PostgREST (${e.message})`);
      continue;
    }
    if (isMissingFunctionError(body)) {
      drifts.push({ kind: "rpc", table: `rpc/${name}`, columns: Object.keys(args), reason, code: body?.code, message: body?.message });
      continue;
    }
    if (expect === "ok") {
      if (res.ok) console.log(`  ✓ rpc/${name} — resolves and answers`);
      else errors.push(`rpc/${name}: unexpected ${res.status} response — ${body?.message ?? "unknown error"}`);
      continue;
    }
    // expect === "denied"
    if (isPermissionDenied(body)) {
      console.log(`  ✓ rpc/${name} — resolves and is denied to anon (service-only, as intended)`);
    } else if (res.ok) {
      regressions.push(`rpc/${name}: anon may EXECUTE a service-only function (HTTP ${res.status}) — ${reason}`);
    } else {
      errors.push(`rpc/${name}: unexpected ${res.status} response — ${body?.message ?? "unknown error"}`);
    }
  }

  if (drifts.length === 0 && errors.length === 0 && regressions.length === 0) {
    console.log("check-schema-drift: OK — the live DB serves every required read and RPC.");
    process.exit(0);
  }

  if (errors.length) {
    console.error("\ncheck-schema-drift: could not verify (configuration/connectivity):");
    for (const e of errors) console.error(`  ✗ ${e}`);
  }
  if (regressions.length) {
    console.error("\ncheck-schema-drift: HARDENING REGRESSION — a service-only function is client-callable:");
    for (const r of regressions) console.error(`  ✗ ${r}`);
    console.error("  Fix: re-apply the revoke (migrations 0149 / 0151) — see docs/db-release-runbook.md.");
  }
  if (drifts.length) {
    console.error("\ncheck-schema-drift: SCHEMA DRIFT — the live DB is behind the deployed app:");
    for (const d of drifts) {
      const what = d.kind === "rpc" ? `cannot call with [${d.columns.join(", ")}]` : `cannot read [${d.columns.join(", ")}]`;
      console.error(`  ✗ ${d.table}: ${what}  (${d.code}) — ${d.message}`);
      console.error(`      needed for: ${d.reason}`);
    }
    console.error(
      "\n  Fix: apply the pending migrations to this project, then reload the PostgREST schema cache:\n" +
        "    supabase db push            # (or run the specific pending DDL)\n" +
        "    psql \"$SUPABASE_DB_URL\" -c \"notify pgrst, 'reload schema';\"   # or Dashboard → Settings → API → Reload schema\n" +
        "  See docs/db-release-runbook.md.",
    );
  }
  process.exit(1);
}

// Only run when invoked directly (so the classifiers can be imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
