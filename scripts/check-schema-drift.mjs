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
 * It is ledger-independent by design: it probes what the app actually reads, not schema_migrations
 * (which this project is known to under-report).
 *
 * Opt-in + safe: with SUPABASE_URL / SUPABASE_ANON_KEY unset it prints a skip notice and exits 0, so
 * it never breaks a fork PR or an unconfigured repo. Configured, it exits non-zero on drift (or on a
 * connectivity/auth misconfig, with a distinct message) so a deploy/main run fails visibly.
 *
 * Run:  node scripts/check-schema-drift.mjs        (reads env SUPABASE_URL, SUPABASE_ANON_KEY)
 */

/**
 * The reads the deployed app depends on. Extend this as new required columns land — it is the living
 * contract between app code and the live schema. Each entry is probed as
 * `GET /rest/v1/<table>?select=<columns>&limit=1`.
 */
const REQUIRED_READS = [
  {
    table: "channels",
    columns: ["key", "surface", "sections", "nav", "membership_mode"],
    reason: "F2G storefront chrome + open-mode venue query (migrations 0122, 0134)",
  },
];

/** Classify a PostgREST response body as a drift error (missing column / stale schema cache). */
export function isDriftError(body) {
  const code = String(body?.code ?? "");
  if (code === "42703" || code === "PGRST204") return true;
  const msg = String(body?.message ?? "").toLowerCase();
  return msg.includes("schema cache") || (msg.includes("column") && msg.includes("does not exist"));
}

async function main() {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.log(
      "check-schema-drift: SUPABASE_URL / SUPABASE_ANON_KEY not set — skipping (not configured).\n" +
        "  Set both (repo/deploy secrets) to enable the live-schema drift guard.",
    );
    process.exit(0);
  }

  const drifts = [];
  const errors = [];

  for (const { table, columns, reason } of REQUIRED_READS) {
    const endpoint = `${url}/rest/v1/${table}?select=${columns.join(",")}&limit=1`;
    let res, body;
    try {
      res = await fetch(endpoint, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
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
      drifts.push({ table, columns, reason, code: body?.code, message: body?.message });
    } else {
      // Not a drift shape — a bad key, RLS, or transport problem. Surface it distinctly so the
      // operator fixes the config rather than mistaking it for a schema gap.
      errors.push(`${table}: unexpected ${res.status} response — ${body?.message ?? "unknown error"}`);
    }
  }

  if (drifts.length === 0 && errors.length === 0) {
    console.log("check-schema-drift: OK — the live DB serves every required read.");
    process.exit(0);
  }

  if (errors.length) {
    console.error("\ncheck-schema-drift: could not verify (configuration/connectivity):");
    for (const e of errors) console.error(`  ✗ ${e}`);
  }
  if (drifts.length) {
    console.error("\ncheck-schema-drift: SCHEMA DRIFT — the live DB is behind the deployed app:");
    for (const d of drifts) {
      console.error(`  ✗ ${d.table}: cannot read [${d.columns.join(", ")}]  (${d.code}) — ${d.message}`);
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

// Only run when invoked directly (so isDriftError can be imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
