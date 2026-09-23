/**
 * Standalone API service entry — Shape B.
 *
 * Web, console, and native are equal peers that call this service over HTTP; none of
 * them hosts it. This module exposes a single `handler(request)` built on tRPC's
 * fetch adapter, so it deploys to any fetch-native runtime (a Node server, a Netlify
 * Function, an edge runtime) without code change. The runtime-specific shim (e.g. a
 * Netlify Function wrapper) is a few lines that just forward the Request — kept out of
 * here so this stays transport-pure.
 *
 * CORS: because the API is a SEPARATE ORIGIN from the web/console surfaces (Shape B),
 * browsers enforce CORS on every call. We allow the configured surface origins, answer
 * the preflight OPTIONS request, and echo the headers tRPC's batch client needs. Allowed
 * origins come from CORS_ALLOWED_ORIGINS (comma-separated); in dev we default to the
 * local Next origins. Server-to-server callers (Edge Functions / cron) are unaffected —
 * CORS is a browser concept and those calls carry the x-internal-call secret instead.
 *
 * Env is read ONCE at module load and fail-fast: a missing secret should crash the
 * service at boot, not silently degrade auth at request time.
 */
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { money, channels as coreChannels } from "@roam/core";
import { appRouter } from "./routers/index.js";
import { makeContextFactory, type ApiEnv, type HeaderBag } from "./context.js";
import { makeOriginAllowed } from "./cors.js";
import { escalateToService } from "./trpc.js";
import { notifyOps, installOpsHooks } from "./observability/ops.js";
import { pushToProfileIds } from "./push/dispatch.js";
import { runBirthdayDelivery } from "./jobs/deliverBirthdays.js";
import { runAwinOffersSync } from "./jobs/syncAwinOffers.js";
import { runCjOffersSync } from "./jobs/syncCjOffers.js";
import { runCjLogoSync } from "./jobs/syncCjLogos.js";
import { runOwnerDigest } from "./jobs/deliverOwnerDigest.js";
import { runFsaSync } from "./jobs/syncFsaNi.js";
import { loadFsaConfig } from "./fsa/client.js";
import { runAllHubspotSyncs } from "./jobs/syncHubspotMembers.js";
import { loadHubspotAppConfig, verifyState, exchangeCode, describeToken } from "./hubspot/oauth.js";
import { connectIntegration } from "./hubspot/store.js";
import { verifyStripeSignature } from "./stripe/client.js";
import type { EfaConfig } from "./transit/client.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `[@roam/api] Missing required env var ${name}. Refusing to start. ` +
        `Populate it from the RoamLocal Core Project dashboard — never from a DDS key.`,
    );
  }
  return v;
}

function loadEnv(): ApiEnv {
  return {
    supabase: {
      url: requireEnv("SUPABASE_URL"),
      anonKey: requireEnv("SUPABASE_ANON_KEY"),
    },
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    internalCallSecret: requireEnv("INTERNAL_CALL_SECRET"),
    // Optional web-scoped secret (holistic plan Phase 1.5). Unset = the web keeps using the full
    // secret; set (and distinct) = the web's server routes get web scope only (internalScopes.ts).
    internalCallSecretWeb: process.env.INTERNAL_CALL_SECRET_WEB?.trim() || null,
    vapid: {
      subject: requireEnv("VAPID_SUBJECT"),
      // Deliberately the NEXT_PUBLIC_-prefixed var: this is the SAME public key the
      // web bundle inlines, and web-push's setVapidDetails needs both keys to sign.
      // Not a bug — the API reads other env unprefixed, but the public key is shared.
      publicKey: requireEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY"),
      privateKey: requireEnv("VAPID_PRIVATE_KEY"),
    },
    places: {
      apiKey: requireEnv("GOOGLE_PLACES_API_KEY_CORE"),
    },
    brevo: {
      // Optional: when unset the contact sync is a no-op (the API still boots). List ids
      // default to the launch lists but can be overridden per environment.
      apiKey: process.env.BREVO_API_KEY ?? null,
      newUserListId: Number(process.env.BREVO_LIST_NEW_USERS ?? "93"),
      businessListId: Number(process.env.BREVO_LIST_BUSINESSES ?? "3"),
      senderEmail: process.env.BREVO_SENDER_EMAIL ?? "no-reply@roam-local.com",
      senderName: process.env.BREVO_SENDER_NAME ?? "Roam",
    },
    ownerDigest: {
      // Optional: unset leaves the unsubscribe route disabled and the owner digest dormant.
      unsubscribeSecret: process.env.OWNER_DIGEST_UNSUBSCRIBE_SECRET ?? null,
    },
    f2g: {
      // Optional: unset F2G_INVITE_SECRET leaves the invite→claim path dormant (the claim endpoint
      // rejects every token, the send path refuses to issue links), so the API boots before it is
      // provisioned. A dedicated secret — rotating it invalidates outstanding invites (resend).
      inviteSecret: process.env.F2G_INVITE_SECRET ?? null,
      inviteTtlDays: (() => {
        const n = Number(process.env.F2G_INVITE_TTL_DAYS ?? "14");
        return Number.isFinite(n) && n > 0 ? n : 14;
      })(),
    },
    transit: {
      // Optional: unset TRANSLINK_API_KEY leaves config null and the NI transit feature dormant
      // (nearbyDepartures returns "unconfigured"), so the API boots fine before provisioning.
      config: loadTransitConfig(),
    },
    awin: {
      // Optional: unset AWIN_API_KEY leaves the deals ingestion dormant (the sync route no-ops), so
      // the API boots before the token is provisioned. publisherId auto-resolves via /accounts when
      // unset. AWIN_DEBUG=1 logs the raw offers response so the field-mapping can be confirmed.
      apiKey: process.env.AWIN_API_KEY ?? null,
      publisherId: process.env.AWIN_PUBLISHER_ID ?? null,
      baseUrl: process.env.AWIN_API_BASE ?? "https://api.awin.com",
      region: process.env.AWIN_REGION ?? "GB",
      membership: process.env.AWIN_MEMBERSHIP ?? "joined",
      debug: process.env.AWIN_DEBUG === "1" || process.env.AWIN_DEBUG === "true",
      offersPath: process.env.AWIN_OFFERS_PATH ?? null,
      offersMethod: process.env.AWIN_OFFERS_METHOD ?? null,
    },
    cj: {
      // Optional: unset CJ_API_TOKEN/CJ_WEBSITE_ID leaves the CJ deals ingestion dormant (the sync
      // route no-ops), so the API boots before CJ is provisioned. CJ_DEBUG=1 logs the raw first
      // Link Search response so the field-mapping can be confirmed (CJ returns XML).
      token: process.env.CJ_API_TOKEN ?? null,
      websiteId: process.env.CJ_WEBSITE_ID ?? null,
      baseUrl: process.env.CJ_API_BASE ?? "https://link-search.api.cj.com",
      advertiserLookupBaseUrl: process.env.CJ_ADVERTISER_LOOKUP_BASE ?? "https://advertiser-lookup.api.cj.com",
      advertiserLookupCid: process.env.CJ_CID ?? null,
      advertiserIds: process.env.CJ_ADVERTISER_IDS ?? "joined",
      linkType: process.env.CJ_LINK_TYPE ?? null,
      promotionType: process.env.CJ_PROMOTION_TYPE ?? null,
      promotionalOnly: !(process.env.CJ_ALL_LINKS === "1" || process.env.CJ_ALL_LINKS === "true"),
      maxPerCategory: Number(process.env.CJ_MAX_PER_CATEGORY ?? "0") || 0,
      region: process.env.CJ_REGION ?? "GB",
      debug: process.env.CJ_DEBUG === "1" || process.env.CJ_DEBUG === "true",
    },
    stripe: {
      // Optional: unset STRIPE_SECRET_KEY leaves the payments surface dormant (procedures answer
      // "not configured", the webhook 503s), so the API boots before Stripe is provisioned.
      secretKey: process.env.STRIPE_SECRET_KEY ?? null,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? null,
      webhookSecretPlatform: process.env.STRIPE_WEBHOOK_SECRET_PLATFORM ?? null,
      // Where Stripe's hosted-onboarding redirects land: the web app. Falls back to the first
      // allowed CORS origin (the deployed web origin in prod, localhost in dev).
      webOrigin:
        process.env.WEB_ORIGIN ??
        (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:3000").split(",")[0]!.trim(),
      // Platform commission in basis points (500 = 5%). Read at charge time, so tuning it is
      // an env change, never a deploy of new code. Guard a malformed value back to 5% so a typo
      // can't ship a NaN application fee that Stripe rejects only at the point of sale.
      applicationFeeBps: (() => {
        const n = Number(process.env.PLATFORM_FEE_BPS ?? "500");
        return Number.isFinite(n) && n >= 0 ? n : 500;
      })(),
    },
    alerts: {
      webhookUrl: process.env.ALERT_WEBHOOK_URL?.trim() || null,
    },
  };
}

/** The documented Translink Opendata EFA base (overridable). https per Translink's own examples. */
const TRANSLINK_DEFAULT_BASE = "https://opendata.translinkniplanner.co.uk/Ext_API/";

/**
 * Resolve the Translink EFA config from env, or null when no key is set.
 *
 * AUTH — CONFIRMED (Gary @ Translink, Aug 2026): the key rides as an HTTP header named
 * `X-API-TOKEN` (verified working, 200 OK, via Translink's own Postman collection). Those are the
 * defaults below, so it works out of the box. The query-param form is retained as an automatic
 * FALLBACK (the client tries the primary, then the alternate on an auth-status rejection, pinning
 * + logging whichever wins) — a cheap safety net if Translink ever changes the injection, not
 * because the answer is unknown. Every knob stays overridable via env:
 *   - TRANSLINK_AUTH_MODE = header (default) | query   → the primary (tried first)
 *   - header name       from TRANSLINK_AUTH_HEADER (default "X-API-TOKEN")
 *   - query param name  from TRANSLINK_AUTH_PARAM  (default "key")
 *   - TRANSLINK_DEBUG=1 logs the raw (truncated) EFA JSON so a deploy can confirm the shape.
 */
function loadTransitConfig(): EfaConfig | null {
  const value = process.env.TRANSLINK_API_KEY;
  if (!value) return null;
  const baseUrl = process.env.TRANSLINK_API_BASE ?? TRANSLINK_DEFAULT_BASE;
  const mode = process.env.TRANSLINK_AUTH_MODE === "query" ? "query" : "header";
  const paramName = process.env.TRANSLINK_AUTH_PARAM ?? "key";
  const headerName = process.env.TRANSLINK_AUTH_HEADER ?? "X-API-TOKEN";

  const queryAuth = { mode: "query" as const, name: paramName, value };
  const headerAuth = { mode: "header" as const, name: headerName, value };
  const primary = mode === "header" ? headerAuth : queryAuth;
  const fallback = mode === "header" ? queryAuth : headerAuth;

  return {
    baseUrl,
    auth: primary,
    authFallback: fallback,
    debug: process.env.TRANSLINK_DEBUG === "1" || process.env.TRANSLINK_DEBUG === "true",
    // Optional static-IP forward proxy (QuotaGuard Static / Fixie). Railway egress rotates within
    // a /23 pool, so registering a single Railway IP with Translink won't hold; routing through a
    // proxy gives one fixed IP to register. Unset = calls go out directly from Railway.
    proxyUrl: process.env.TRANSLINK_PROXY_URL ?? null,
  };
}

const env = loadEnv();
const createContext = makeContextFactory(env);
// Last line of defence: unhandled rejections / uncaught exceptions become an ops alert (Phase 1.4).
installOpsHooks();

/**
 * Allowed browser origins for CORS. Comma-separated CORS_ALLOWED_ORIGINS in prod;
 * sensible local Next origins in dev — web (3000), business console (3001), and Roam
 * HQ admin (3002). Read once at boot.
 */
const allowedOrigins: string[] = (
  process.env.CORS_ALLOWED_ORIGINS ??
  "http://localhost:3000,http://localhost:3001,http://localhost:3002"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Whether a browser origin is permitted — exact match, or a `*` subdomain-wildcard entry so the
// co-brand channel hosts (nifood2go.roam-local.com, …) all clear CORS without per-domain env churn.
const isOriginAllowed = makeOriginAllowed(allowedOrigins);

/** Build the CORS headers for a given request origin (echo it only if allowed). */
function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // x-roam-channel is sent by the browser tRPC client on every co-brand-host call (it's how the
    // host-blind API learns the active channel) — it MUST be allowed here or the preflight rejects
    // it and no data loads on the storefront. See apps/web/src/lib/trpc.ts.
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-internal-call, x-roam-channel",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && isOriginAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/** Adapt a standard fetch Headers object to our transport-agnostic HeaderBag. */
function toHeaderBag(headers: Headers): HeaderBag {
  return { get: (name: string) => headers.get(name) };
}

/** A JSON Response carrying the CORS headers (used by the raw internal cron route). */
function jsonResponse(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/**
 * A plain page for the one endpoint a PERSON lands on rather than a program: the OAuth callback,
 * where a partner's browser arrives after they approve access. The message is escaped because it can
 * include values from the query string (a provider's error code), and no CORS headers are set —
 * this is a top-level navigation, not a cross-origin fetch.
 */
function htmlResponse(message: string, status: number): Response {
  const safe = message.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Roam</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem;color:#20140E">` +
      `<p>${safe}</p></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

/**
 * The fetch handler. Point any fetch-native runtime at this.
 *   export default { fetch: handler }   // edge / Bun / Deno
 *   // or wrap in a Netlify Function that forwards (request) => handler(request)
 */
export async function handler(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  const cors = corsHeaders(origin);

  // Preflight: answer OPTIONS immediately with the CORS headers, no body.
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  // Internal cron route (NOT tRPC). The daily birthday delivery is triggered by Supabase
  // pg_cron via pg_net, which posts plain JSON and cannot speak tRPC's batch envelope — so it
  // gets its own raw path. Auth is the SAME internal-call secret gate every server-to-server
  // caller uses (Edge Functions / cron / webhooks): we build the context purely to reuse its
  // isInternalCall check, then escalate to a service client and run the shared job code.
  // Idempotent — deliver_birthday_offers() is `on conflict do nothing` per (venue,user,day),
  // so a double-fire delivers once. Never JWT-gated: there is no user; the secret is the gate.
  const pathname = new URL(request.url).pathname;

  // Health (holistic plan Phase 1.4). Unauthenticated and cheap: process up + one trivial DB read.
  // Railway's healthcheckPath (railway.json) and any external uptime monitor hit this; a 503 here is
  // the first thing an on-call person sees. The DB probe alerts (deduped) so a dead database is a
  // message, not a mystery.
  if (pathname === "/healthz") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, cors);
    }
    let db: "ok" | "error" = "ok";
    let dbError: string | null = null;
    try {
      const service = escalateToService(env);
      const { error } = await (service as unknown as {
        from: (t: string) => { select: (c: string) => { limit: (n: number) => Promise<{ error: { message: string } | null }> } };
      })
        .from("channels")
        .select("id")
        .limit(1);
      if (error) throw new Error(error.message);
    } catch (e) {
      db = "error";
      dbError = e instanceof Error ? e.message : String(e);
      void notifyOps({ key: "healthz.db", title: "Health check: database unreachable", detail: dbError });
    }
    const body = {
      ok: db === "ok",
      db,
      version: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_SHA ?? null,
      uptimeSeconds: Math.round(process.uptime()),
      ...(dbError ? { error: dbError } : {}),
    };
    return jsonResponse(body, db === "ok" ? 200 : 503, { ...cors, "Cache-Control": "no-store" });
  }

  if (pathname === "/jobs/deliver-birthdays") {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, cors);
    }
    const ctx = createContext({ headers: toHeaderBag(request.headers) });
    if (ctx.internalScope !== "full") {
      return jsonResponse({ ok: false, error: "forbidden" }, 403, cors);
    }
    try {
      const service = escalateToService(ctx.env);
      const result = await runBirthdayDelivery(service, ctx.env.vapid);
      return jsonResponse({ ok: true, ...result }, 200, cors);
    } catch (e) {
      return jsonResponse(
        { ok: false, error: e instanceof Error ? e.message : String(e) },
        500,
        cors,
      );
    }
  }

  // Internal cron route: the daily owner activity digest email. Same internal-secret gate as the
  // birthday route; dormant (status "unconfigured") until the Brevo sender + unsubscribe secret are
  // set. Idempotent per-owner per-day via the owner_digest_state watermark.
  if (pathname === "/jobs/deliver-owner-digest") {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, cors);
    }
    const ctx = createContext({ headers: toHeaderBag(request.headers) });
    if (ctx.internalScope !== "full") {
      return jsonResponse({ ok: false, error: "forbidden" }, 403, cors);
    }
    try {
      const service = escalateToService(ctx.env);
      const result = await runOwnerDigest(
        service,
        {
          brevoApiKey: ctx.env.brevo.apiKey,
          sender: { email: ctx.env.brevo.senderEmail, name: ctx.env.brevo.senderName },
          unsubscribeSecret: ctx.env.ownerDigest.unsubscribeSecret,
          webOrigin: ctx.env.stripe.webOrigin,
        },
        (m) => console.log(m),
      );
      return jsonResponse({ ok: true, ...result }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500, cors);
    }
  }

  // Internal cron route: sync Awin affiliate offers into awin_deals. Same internal-secret gate as
  // the birthday route; dormant when AWIN_API_KEY is unset (returns "unconfigured", not an error).
  // Triggered by pg_cron on a schedule; idempotent (upsert-by-promotion-id).
  if (pathname === "/jobs/sync-awin-offers") {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, cors);
    }
    const ctx = createContext({ headers: toHeaderBag(request.headers) });
    if (ctx.internalScope !== "full") {
      return jsonResponse({ ok: false, error: "forbidden" }, 403, cors);
    }
    const awin = ctx.env.awin;
    if (!awin.apiKey) {
      return jsonResponse({ ok: false, error: "unconfigured" }, 200, cors);
    }
    try {
      const service = escalateToService(ctx.env);
      const result = await runAwinOffersSync(service, { ...awin, apiKey: awin.apiKey }, (m) => console.log(m));
      return jsonResponse({ ok: true, ...result }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500, cors);
    }
  }

  // Internal cron route: sync CJ affiliate deals into cj_deals. Same internal-secret gate as the
  // Awin route; dormant when CJ_API_TOKEN / CJ_WEBSITE_ID are unset (returns "unconfigured", not an
  // error). Triggered by pg_cron on a schedule; idempotent (upsert-by-link-id).
  if (pathname === "/jobs/sync-cj-offers") {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, cors);
    }
    const ctx = createContext({ headers: toHeaderBag(request.headers) });
    if (ctx.internalScope !== "full") {
      return jsonResponse({ ok: false, error: "forbidden" }, 403, cors);
    }
    const cj = ctx.env.cj;
    if (!cj.token || !cj.websiteId) {
      return jsonResponse({ ok: false, error: "unconfigured" }, 200, cors);
    }
    try {
      const service = escalateToService(ctx.env);
      const result = await runCjOffersSync(service, { ...cj, token: cj.token, websiteId: cj.websiteId }, (m) => console.log(m));
      return jsonResponse({ ok: true, ...result }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500, cors);
    }
  }

  // Internal cron route: look up CJ advertiser logos into cj_advertisers (companion to the CJ offers
  // sync — the deals router attaches these logos to CJ cards at read time). Same internal-secret gate;
  // dormant when CJ_API_TOKEN / CJ_WEBSITE_ID are unset. Idempotent (upsert-by-advertiser-id).
  if (pathname === "/jobs/sync-cj-logos") {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, cors);
    }
    const ctx = createContext({ headers: toHeaderBag(request.headers) });
    if (ctx.internalScope !== "full") {
      return jsonResponse({ ok: false, error: "forbidden" }, 403, cors);
    }
    const cj = ctx.env.cj;
    if (!cj.token || !cj.websiteId) {
      return jsonResponse({ ok: false, error: "unconfigured" }, 200, cors);
    }
    try {
      const service = escalateToService(ctx.env);
      const result = await runCjLogoSync(service, { ...cj, token: cj.token, websiteId: cj.websiteId }, (m) => console.log(m));
      return jsonResponse({ ok: true, ...result }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500, cors);
    }
  }

  // Internal cron route: pull NI FSA hygiene ratings into fsa_establishments + match to venues (C1).
  // Same internal-secret gate; dormant when FSA_NI_AUTHORITY_IDS is unset (returns "unconfigured").
  // Triggered by pg_cron nightly; idempotent (upsert-by-fhrsid; never overwrites a manual match).
  if (pathname === "/jobs/sync-fsa-ni") {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, cors);
    }
    const ctx = createContext({ headers: toHeaderBag(request.headers) });
    if (ctx.internalScope !== "full") {
      return jsonResponse({ ok: false, error: "forbidden" }, 403, cors);
    }
    const cfg = loadFsaConfig();
    if (!cfg) {
      return jsonResponse({ ok: false, error: "unconfigured" }, 200, cors);
    }
    try {
      const service = escalateToService(ctx.env);
      const result = await runFsaSync(service, cfg, (m) => console.log(m));
      return jsonResponse({ ok: true, ...result }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500, cors);
    }
  }

  // HubSpot member sync (plan 2.3), across EVERY connected partner. `?full=1` ignores the
  // incremental window; `?dry=1` computes and reports without writing. Full scope only — it reads
  // partners' contact PII, so the web deployment's scoped secret must never reach it (plan 1.5).
  if (pathname === "/jobs/sync-hubspot-members") {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, cors);
    }
    const ctx = createContext({ headers: toHeaderBag(request.headers) });
    if (ctx.internalScope !== "full") {
      return jsonResponse({ ok: false, error: "forbidden" }, 403, cors);
    }
    const app = loadHubspotAppConfig();
    if (!app) {
      return jsonResponse({ ok: false, error: "unconfigured" }, 200, cors);
    }
    const params = new URL(request.url).searchParams;
    const full = params.get("full") === "1";
    try {
      const service = escalateToService(ctx.env);
      const result = await runAllHubspotSyncs(
        service,
        app,
        { since: full ? null : new Date(Date.now() - 36 * 60 * 60 * 1000), dryRun: params.get("dry") === "1" },
        (m) => console.log(m),
      );
      return jsonResponse({ ok: true, ...result }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500, cors);
    }
  }

  // HubSpot OAuth callback — where a partner lands after approving access in their own portal.
  //
  // PUBLIC by necessity (HubSpot redirects a browser here, carrying no Roam credentials), so the
  // `state` parameter is the entire authorisation: it is HMAC-signed with a short expiry and names
  // the channel being connected. An unsigned or stale state is refused before any token exchange —
  // otherwise anyone could bind their own HubSpot portal to someone else's channel.
  if (pathname === "/integrations/hubspot/callback") {
    const app = loadHubspotAppConfig();
    if (!app) return htmlResponse("HubSpot is not configured on this deployment.", 503);

    const params = new URL(request.url).searchParams;
    const denied = params.get("error");
    if (denied) return htmlResponse(`HubSpot returned: ${denied}. Nothing was connected.`, 400);

    const channelKey = verifyState(params.get("state"), app.stateSecret);
    if (!channelKey) return htmlResponse("That connect link is invalid or has expired. Start again from Roam HQ.", 400);

    const code = params.get("code");
    if (!code) return htmlResponse("HubSpot did not return an authorisation code.", 400);

    try {
      const service = escalateToService(createContext({ headers: toHeaderBag(request.headers) }).env);
      const channel = await coreChannels.getChannelByKey(service, channelKey);
      if (!channel) return htmlResponse("Unknown channel for that connect link.", 400);

      const tokens = await exchangeCode(app, code);
      // Record WHICH portal was approved: the commonest quiet failure in a multi-tenant OAuth
      // integration is a partner approving while signed into the wrong account.
      const described = await describeToken(app, tokens.accessToken);
      await connectIntegration(service, {
        channelId: channel.id,
        tokens,
        externalAccountId: described.hubId,
        scopes: described.scopes,
      });
      return htmlResponse(
        `HubSpot connected for ${channel.name}${described.hubId ? ` (portal ${described.hubId})` : ""}. ` +
          `You can close this window.`,
        200,
      );
    } catch (e) {
      return htmlResponse(`Could not complete the connection: ${e instanceof Error ? e.message : String(e)}`, 500);
    }
  }

  // Stripe webhook (NOT tRPC — Stripe posts raw JSON and signs the exact bytes). Auth is the
  // signature check itself: verifyStripeSignature proves the payload came from Stripe and is
  // fresh, so no internal-call secret applies here. PR 1 handles account.updated (payout
  // onboarding status sync); payment events join in the checkout slice. Always answers 200 on
  // a verified event — even ones we ignore — so Stripe doesn't retry them forever.
  if (pathname === "/webhooks/stripe") {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, cors);
    }
    // Two destinations post here — the connected-accounts one (account.updated) and the
    // platform one (checkout events) — each with its own signing secret; accept either.
    const secrets = [env.stripe.webhookSecret, env.stripe.webhookSecretPlatform].filter(
      (s): s is string => !!s,
    );
    if (!env.stripe.secretKey || secrets.length === 0) {
      return jsonResponse({ ok: false, error: "unconfigured" }, 503, cors);
    }
    const rawBody = await request.text();
    const signature = request.headers.get("stripe-signature");
    if (!secrets.some((s) => verifyStripeSignature(rawBody, signature, s, Date.now()))) {
      return jsonResponse({ ok: false, error: "bad_signature" }, 400, cors);
    }
    try {
      const event = JSON.parse(rawBody) as {
        type?: string;
        data?: {
          object?: {
            id?: string;
            charges_enabled?: boolean;
            payouts_enabled?: boolean;
            details_submitted?: boolean;
            payment_intent?: string;
            metadata?: { order_id?: string };
          };
        };
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type Loose = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };
      if (event.type === "account.updated" && event.data?.object?.id) {
        const acct = event.data.object;
        const service = escalateToService(env);
        await (service as unknown as Loose)
          .from("venue_payment_accounts")
          .update({
            charges_enabled: acct.charges_enabled ?? false,
            payouts_enabled: acct.payouts_enabled ?? false,
            details_submitted: acct.details_submitted ?? false,
          })
          .eq("stripe_account_id", acct.id);
      } else if (event.type === "checkout.session.completed" && event.data?.object?.metadata?.order_id) {
        // Payment landed: pending → paid (idempotent — the eq(status,'pending') makes a
        // replayed event a no-op), then decrement tracked stock once.
        const session = event.data.object;
        const orderId = session.metadata!.order_id!;
        const service = escalateToService(env) as unknown as Loose;
        const { data: updated } = (await service
          .from("orders")
          .update({ status: "paid", stripe_payment_intent_id: session.payment_intent ?? null })
          .eq("id", orderId)
          .eq("status", "pending")
          .select("id, product_id, quantity, venue_id, buyer_id, product_title, product_kind, fulfilment_type, amount_pence, delivery_fee_pence, currency")) as {
          data: { id: string; product_id: string | null; quantity: number; venue_id: string; buyer_id: string | null; product_title: string; product_kind: string; fulfilment_type: string | null; amount_pence: number; delivery_fee_pence: number | null; currency: string | null }[] | null;
        };
        const order = updated?.[0];
        if (order) {
          // What the buyer actually paid = goods subtotal + any delivery fee. Cart orders store the
          // two separately (amount_pence is goods-only); a collection/single-item order has no fee.
          const totalPence = order.amount_pence + (order.delivery_fee_pence ?? 0);
          // Format in the ORDER's currency — a non-UK venue charges usd/eur, so a hard-coded £
          // would lie in the confirmation bell + push (fixed: multi-currency review #8).
          const pounds = money.formatPence(totalPence, order.currency);

          // Decrement tracked stock FIRST — the money-adjacent side effect. Cart orders carry
          // order_items (decrement each line); the legacy single-item checkout has none, so fall
          // back to the header product. Wrapped so a transient failure never 500s the webhook —
          // which would make Stripe retry, find the order already paid, and skip stock entirely.
          try {
            const { data: items } = (await service
              .from("order_items")
              .select("product_id, quantity")
              .eq("order_id", order.id)) as { data: { product_id: string | null; quantity: number }[] | null };
            const toDecrement =
              items && items.length > 0
                ? items
                : order.product_id
                  ? [{ product_id: order.product_id, quantity: order.quantity }]
                  : [];
            for (const line of toDecrement) {
              if (!line.product_id) continue;
              // Atomic decrement: the RPC holds a row lock across its read+write, so two paid
              // webhooks racing for the last unit can't both see stock=1 and both write 0
              // (the oversell #12 fixed by migration 0132). It also never drives stock
              // negative and classifies the outcome so a genuine oversell is observable.
              const { data: dec } = (await service.rpc("decrement_stock", {
                product_id_param: line.product_id,
                qty: line.quantity,
              })) as { data: { outcome: string; new_stock: number | null }[] | null };
              const outcome = dec?.[0]?.outcome;
              if (outcome === "oversold") {
                // A buyer paid for stock that no longer existed. Payment stands (we never fail
                // the webhook); surface it so ops can reconcile with the venue.
                console.error(
                  `[stock] oversold: order ${order.id} product ${line.product_id} qty ${line.quantity} — sold beyond available stock`,
                );
              }
            }
          } catch {
            /* stock decrement is best-effort — never fail payment confirmation */
          }

          // The marketplace nervous system: the sale lands in the venue's Activity feed, and the
          // buyer's bell confirms payment. All best-effort — wrapped so an insert failure can't 500
          // the webhook (same retry trap as the stock note above).
          try {
            await service.from("venue_activity").insert({
              venue_id: order.venue_id,
              type: "sale",
              actor_id: order.buyer_id,
              payload: { orderId: order.id, offerTitle: order.product_title, amountPence: totalPence },
            });
            if (order.buyer_id) {
              await service.from("notifications").insert({
                recipient_id: order.buyer_id,
                type: "order_paid",
                payload: {
                  text:
                    order.product_kind === "service"
                      ? `Payment confirmed — “${order.product_title}” (${pounds}). Your redeem code is in Your orders.`
                      : order.fulfilment_type === "delivery"
                        ? `Payment confirmed — “${order.product_title}” (${pounds}). We'll let you know when it's on its way.`
                        : `Payment confirmed — “${order.product_title}” (${pounds}). Collect it in venue.`,
                  href: "/orders",
                },
              });
              try {
                await pushToProfileIds(escalateToService(env), env.vapid, [order.buyer_id], {
                  url: "/orders",
                  title: "Order confirmed",
                  body: `“${order.product_title}” (${pounds}) — we'll let you know when it's ready.`,
                });
              } catch {
                /* push is best-effort */
              }
            }
            const { data: ownerRow } = (await service
              .from("venues")
              .select("owner_id")
              .eq("id", order.venue_id)
              .maybeSingle()) as { data: { owner_id: string | null } | null };
            if (ownerRow?.owner_id && ownerRow.owner_id !== order.buyer_id) {
              await service.from("notifications").insert({
                recipient_id: ownerRow.owner_id,
                type: "order_received",
                payload: { text: `New order — “${order.product_title}” (${pounds}).`, href: "/dashboard" },
              });
            }
          } catch {
            /* activity + notifications are best-effort — never fail payment confirmation */
          }
        }
      }
      return jsonResponse({ received: true }, 200, cors);
    } catch (e) {
      return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500, cors);
    }
  }

  const response = await fetchRequestHandler({
    endpoint: "/trpc",
    req: request,
    router: appRouter,
    createContext: () => createContext({ headers: toHeaderBag(request.headers) }),
    // Unexpected server errors are incidents, not just 500s: alert (deduped per procedure) so a
    // broken procedure is noticed before a user reports it. Expected client errors (auth, input,
    // not-found, precondition) are silent by design.
    onError({ error, path }) {
      if (error.code === "INTERNAL_SERVER_ERROR") {
        void notifyOps({
          key: `trpc.internal:${path ?? "unknown"}`,
          title: `tRPC ${path ?? "unknown"} threw INTERNAL_SERVER_ERROR`,
          detail: `${error.message}\n${error.cause instanceof Error ? error.cause.stack ?? "" : ""}`,
        });
      }
    },
  });

  // Attach CORS headers to the actual response (clone so we can add headers).
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
