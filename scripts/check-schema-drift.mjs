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
 * A table carrying `expect: "empty"` is service-managed — RLS on with NO policy — so it answers 200
 * with zero rows rather than refusing, and is asserted that way round: rows coming back is the
 * regression.
 *
 * EXCEPT when the table's RLS policy calls a SECURITY DEFINER function that anon may not EXECUTE
 * (0151's posture). Postgres then refuses the statement outright with SQLSTATE 42501 rather than
 * returning an empty set, so such a table carries `expect: "denied"` and is asserted the other way
 * round: a 42501 is the pass, and a 2xx is a HARDENING regression. This still proves the columns
 * exist, because name resolution happens while the statement is planned — before the policy's
 * function is ever called — so a missing column yields 42703 (drift) and never reaches 42501.
 *
 * Keep each `columns` list to what the app actually selects (packages/core, packages/api, apps/web),
 * citing the migration that introduced it, so a failure names the migration to apply.
 */
export const REQUIRED_READS = [
  {
    table: "channels",
    columns: ["key", "surface", "sections", "nav", "membership_mode", "platform_fee_bps", "org_name", "contact_email"],
    reason: "F2G storefront chrome + open-mode venue query + per-channel fee + partner identity (migrations 0122, 0134, 0149, 0154)",
  },
  {
    table: "channel_domains",
    columns: ["host", "channel_id"],
    reason: "host → channel resolution in the web middleware (migration 0116)",
  },
  {
    table: "venue_channels",
    columns: ["venue_id", "channel_id", "role"],
    reason: "curated-mode storefront + order channel tag lookup + member vs listed (migrations 0116, 0154)",
  },
  {
    table: "channel_members",
    columns: [
      "id", "channel_id", "status", "membership_ref", "venue_id", "source_council", "claimed_by", "lapsed_at",
      "source_system", "source_system_id", "member_no", "last_seen_import_id",
    ],
    reason: "membership spine: roster, matching, HQ status actions, lapse stamp, CRM identity (migrations 0135, 0139, 0150, 0154)",
  },
  {
    table: "channel_integrations",
    columns: ["id", "channel_id", "provider", "status", "external_account_id"],
    reason: "whitelabel partner OAuth connections — HubSpot member sync (migration 0155)",
  },
  {
    table: "channel_admins",
    columns: ["id", "channel_id", "profile_id", "role"],
    reason: "partner organisation officers — the Association portal's authority (migration 0156)",
  },
  {
    table: "channel_activation_codes",
    columns: ["id", "member_id", "venue_id", "profile_id", "expires_at", "attempts", "consumed_at"],
    // Service-managed with RLS on and NO policy (0161). With no policy at all, Postgres matches no
    // rows for a client role rather than raising — so the honest assertion is 200-with-zero-rows,
    // not a refusal. (An earlier revision asserted "denied" here by wrong analogy with
    // channel_feature_requests, whose POLICY calls a definer anon cannot execute; that failed live
    // and taught the distinction.)
    expect: "empty",
    reason: "one-time activation codes — service-managed, no client path (migration 0161)",
  },
  {
    table: "channel_activation_attempts",
    columns: ["id", "channel_id", "member_id", "venue_id", "profile_id", "outcome", "created_at"],
    expect: "empty",
    reason: "activation attempt audit — service-managed, no client path (migration 0161)",
  },
  {
    table: "channel_feature_requests",
    columns: ["id", "channel_id", "created_by", "title", "category", "status", "roam_notes"],
    // Its SELECT policy calls is_channel_officer → is_channel_admin, and 0151 revoked EXECUTE on
    // those from anon, so an anonymous read is refused rather than answered with an empty set.
    expect: "denied",
    reason: "partner feature requests + Roam's reply — officers only (migration 0159)",
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
    name: "venues_in_channel_near",
    args: { filter_channel_id: "00000000-0000-0000-0000-000000000000", origin_lat: 54.5973, origin_lng: -5.9301, page_size: 1, page_offset: 0 },
    expect: "ok",
    reason: "members-mode storefront discovery, now carrying is_member (migrations 0120, 0154)",
  },
  {
    name: "channel_members_search",
    args: { p_channel_key: "f2g", p_query: null, p_council: null, p_lat: null, p_lng: null, p_radius_m: null, p_limit: 1, p_offset: 0 },
    expect: "ok",
    reason: "PII-safe members directory (migration 0144)",
  },
  {
    // Anon is DENIED: 0157 grants these to `authenticated` only, because an anonymous caller has no
    // appointment for is_channel_admin to check. This probe watches the GRANT rather than the gate —
    // if anon ever gains EXECUTE here, a partner's aggregates become reachable without signing in,
    // and that is the drift worth catching from outside the database. The gate itself is proved by
    // supabase/tests/0157_channel_portal_aggregates_test.sql.
    name: "channel_portal_overview",
    args: { p_channel_id: "00000000-0000-0000-0000-000000000000" },
    expect: "denied",
    reason: "Association portal aggregates are authenticated-only (migration 0157)",
  },
  {
    // The members list carries the most sensitive shape in the portal, so its grant is watched too.
    // Decision 5.2 keeps contact details out of the function's signature entirely; this probe guards
    // the other half — that reaching it at all requires being signed in.
    name: "channel_portal_members",
    args: { p_channel_id: "00000000-0000-0000-0000-000000000000" },
    expect: "denied",
    reason: "Association portal members list is authenticated-only (migration 0158)",
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
  return keyInfo(key).role;
}

/**
 * Everything the key says about itself: `role` (see keyRole), `shape` ("legacy-jwt" | "publishable" |
 * "secret" | "unrecognised"), and for a legacy JWT its `ref` claim — the project it was minted for.
 * The ref lets the guard prove the key and SUPABASE_URL belong to the SAME project: a key from one
 * project used against another project's URL is rejected by PostgREST as a bad signature (401), or,
 * if the two projects share a JWT secret, silently probes the wrong database.
 */
export function keyInfo(key) {
  if (typeof key !== "string") return { role: null, shape: "unrecognised", ref: null };
  const k = key.trim();
  if (k.startsWith("sb_publishable_")) return { role: "anon", shape: "publishable", ref: null };
  if (k.startsWith("sb_secret_")) return { role: "service_role", shape: "secret", ref: null };
  const parts = k.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
      return {
        role: typeof payload?.role === "string" ? payload.role : null,
        shape: "legacy-jwt",
        ref: typeof payload?.ref === "string" ? payload.ref : null,
      };
    } catch {
      return { role: null, shape: "unrecognised", ref: null };
    }
  }
  return { role: null, shape: "unrecognised", ref: null };
}

/** The project ref from a Supabase URL (`https://<ref>.supabase.co`), or null. */
export function projectRef(url) {
  const m = /^https?:\/\/([a-z0-9]{15,})\.supabase\.(co|in)\b/i.exec(String(url ?? ""));
  return m ? m[1].toLowerCase() : null;
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

  // ── Preflight: the key MUST be this project's anon key ──────────────────────────────────────
  // Say which project and which kind of key, in the clear: the ref is not sensitive (it is in every
  // public API URL) and it is what makes a wrong-project or wrong-key run diagnosable from the log.
  const urlRef = projectRef(url);
  const info = keyInfo(key);
  console.log(
    `  project ${urlRef ?? "(unrecognised URL)"} — key: ${info.shape}` +
      (info.role ? `, role "${info.role}"` : ", role unknown") +
      (info.ref ? `, minted for project ${info.ref}` : ""),
  );
  if (info.role !== null && info.role !== "anon") {
    console.error(
      `check-schema-drift: SUPABASE_ANON_KEY is a "${info.role}" key, not the anon key. Refusing to run:\n` +
        "  the service-only probes are meaningless with elevated privileges, and a service key must not live\n" +
        "  in this secret. Replace it with the project's anon (public) key — Supabase → Settings → API.",
    );
    process.exit(1);
  }
  // The URL must be a Supabase project (PostgREST answers JSON on every path, including a 404). On
  // 2026-09-17 the secret held the STOREFRONT's own address; a Next.js site answers any path with an
  // HTML 200, so every probe "passed" while probing nothing. Refuse anything that is not PostgREST.
  try {
    const host = new URL(url).host;
    const r = await fetch(`${url}/rest/v1/`, { headers });
    const ct = r.headers.get("content-type") ?? "";
    if (!/json/i.test(ct)) {
      console.error(
        `check-schema-drift: SUPABASE_URL (${host}) is not a Supabase project URL — /rest/v1/ answered ${r.status} ${ct || "(no content-type)"},\n` +
          "  not JSON. This is a website, not the database API. Set SUPABASE_URL to the project's API URL from\n" +
          "  Supabase → Settings → API → Project URL (https://<ref>.supabase.co, or the project's custom API domain).",
      );
      process.exit(1);
    }
  } catch (e) {
    console.error(`check-schema-drift: could not reach ${url} (${e.message})`);
    process.exit(1);
  }

  // Fingerprint the database behind the URL so a "which project is this?" question is answerable from
  // the log: the host (a substring of the secret, so not masked) and a few public row counts to compare
  // with `select count(*)` in the SQL editor of the project you believe this is.
  try {
    const host = new URL(url).host;
    const counts = [];
    for (const t of ["channels", "venues", "fsa_establishments", "channel_members"]) {
      const r = await fetch(`${url}/rest/v1/${t}?select=id&limit=1`, { headers: { ...headers, Prefer: "count=exact" } });
      const cr = r.headers.get("content-range") ?? "";
      counts.push(`${t}=${cr.includes("/") ? cr.split("/")[1] : `? (HTTP ${r.status})`}`);
    }
    console.log(`  fingerprint: host ${host}; public row counts as anon: ${counts.join(", ")}`);
  } catch (e) {
    console.log(`  fingerprint: unavailable (${e.message})`);
  }
  if (info.ref && urlRef && info.ref !== urlRef) {
    console.error(
      `check-schema-drift: SUPABASE_ANON_KEY was minted for project ${info.ref} but SUPABASE_URL points at ${urlRef}.\n` +
        "  Both secrets must come from the SAME project (the one the app reads). Refusing to run.",
    );
    process.exit(1);
  }

  // Behaviourally: places_fetch_quota has RLS on AND all table grants revoked from anon (0130), so an
  // anon read must answer 42501. Interpreting anything else needs the key facts above:
  //   - role unknown + 2xx  → cannot tell elevated privileges from drift; abort.
  //   - role anon    + 2xx  → the request IS anon (the signature verified against this project), so
  //                           the table revoke is not in force here: that is DRIFT (0130), reported
  //                           below with everything else rather than aborting.
  const drifts = [];
  const errors = [];
  const regressions = [];
  try {
    const res = await fetch(`${url}/rest/v1/places_fetch_quota?select=bucket&limit=1`, { headers });
    const body = await res.json().catch(() => null);
    if (res.ok && info.role !== "anon") {
      console.error(
        "check-schema-drift: the key can read places_fetch_quota, which anon cannot (migration 0130), and the\n" +
          "  key's role could not be read from the key itself. Cannot tell a wrong key from drift — refusing to run.\n" +
          "  Use the project's anon (public) key: a legacy 'eyJ…' JWT with role \"anon\", or an sb_publishable_ key.",
      );
      process.exit(1);
    }
    if (res.ok) {
      regressions.push(
        `table places_fetch_quota: anon may READ it (HTTP ${res.status}) — 0130's table revoke is not in force on project ${urlRef ?? "?"}`,
      );
    } else if (isPermissionDenied(body)) {
      console.log("  ✓ preflight — running as the anon role (places_fetch_quota denied, as 0130 intends)");
    } else if (res.status === 401) {
      console.error(
        `check-schema-drift: PostgREST rejected the key (401 — ${body?.message ?? "unknown"}). The key does not verify\n` +
          "  against this project: SUPABASE_URL and SUPABASE_ANON_KEY are from different projects, or the key is stale.",
      );
      process.exit(1);
    } else if (!isDriftError(body)) {
      console.error(`check-schema-drift: preflight got an unexpected ${res.status} — ${body?.message ?? "unknown error"}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`check-schema-drift: could not reach PostgREST for the preflight (${e.message})`);
    process.exit(1);
  }

  for (const { table, columns, reason, expect = "ok" } of REQUIRED_READS) {
    const endpoint = `${url}/rest/v1/${table}?select=${columns.join(",")}&limit=1`;
    let res, body;
    try {
      res = await fetch(endpoint, { headers });
      body = await res.json().catch(() => null);
    } catch (e) {
      errors.push(`${table}: could not reach PostgREST (${e.message})`);
      continue;
    }
    if (expect === "empty") {
      // A service-managed table: RLS on with NO policy. Postgres then matches no rows for a client
      // role, so PostgREST answers 200 with `[]` — it does NOT refuse. (Contrast `denied` below,
      // which applies only where a POLICY EXISTS and calls a definer the role may not execute.)
      //
      // Asserting emptiness rather than mere readability is the strongest thing an anon probe can
      // say about such a table: if a policy were ever added that exposed rows, this catches it.
      // What it CANNOT prove is that RLS is working while the table happens to be empty — an empty
      // table and a correctly-filtered one look identical from out here. That limit is why the
      // pgTAP suite asserts the posture directly (RLS on, zero policies, tripwire trigger) and this
      // probe only guards against a live regression.
      if (isDriftError(body)) {
        drifts.push({ kind: "read", table, columns, reason, code: body?.code, message: body?.message });
      } else if (res.ok && Array.isArray(body) && body.length === 0) {
        console.log(`  ✓ ${table} (${columns.join(", ")}) — resolves and returns no rows to anon (service-managed, as intended)`);
      } else if (res.ok && Array.isArray(body)) {
        regressions.push(`${table}: anon READ returned ${body.length} row(s) from a service-managed table — ${reason}`);
      } else if (res.ok) {
        errors.push(`${table}: ${res.status} but the body is not a PostgREST row array — is SUPABASE_URL the project API?`);
      } else {
        errors.push(`${table}: unexpected ${res.status} response — ${body?.message ?? "unknown error"}`);
      }
      continue;
    }
    if (expect === "denied") {
      // Drift is checked first: a missing column is refused while the statement is planned, before
      // the policy's function runs, so it must not be mistaken for the expected refusal.
      if (isDriftError(body)) {
        drifts.push({ kind: "read", table, columns, reason, code: body?.code, message: body?.message });
      } else if (isPermissionDenied(body)) {
        console.log(`  ✓ ${table} (${columns.join(", ")}) — resolves and is denied to anon (officers only, as intended)`);
      } else if (res.ok) {
        regressions.push(`${table}: anon may READ an officers-only table (HTTP ${res.status}) — ${reason}`);
      } else {
        errors.push(`${table}: unexpected ${res.status} response — ${body?.message ?? "unknown error"}`);
      }
      continue;
    }
    if (res.ok && Array.isArray(body)) {
      console.log(`  ✓ ${table} (${columns.join(", ")}) — readable`);
      continue;
    }
    if (res.ok) {
      // A 2xx that is not a JSON array is not PostgREST answering — never count it as a pass.
      errors.push(`${table}: ${res.status} but the body is not a PostgREST row array — is SUPABASE_URL the project API?`);
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
    console.error(
      "  Fix: re-apply the revokes (migrations 0076 / 0130 / 0149 / 0151) TO THIS PROJECT — see docs/db-release-runbook.md.\n" +
        "  If today's SQL was applied to a different project, that is the finding: this URL is not that project.",
    );
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
