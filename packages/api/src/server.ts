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
import { appRouter } from "./routers/index.js";
import { makeContextFactory, type ApiEnv, type HeaderBag } from "./context.js";
import { escalateToService } from "./trpc.js";
import { runBirthdayDelivery } from "./jobs/deliverBirthdays.js";
import { runAwinOffersSync } from "./jobs/syncAwinOffers.js";
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
      // an env change, never a deploy of new code.
      applicationFeeBps: Number(process.env.PLATFORM_FEE_BPS ?? "500"),
    },
  };
}

/** The documented Translink Opendata EFA base (overridable, e.g. to swap to an https endpoint). */
const TRANSLINK_DEFAULT_BASE = "http://opendata.translinkniplanner.co.uk/Ext_API/";

/**
 * Resolve the Translink EFA config from env, or null when no key is set.
 *
 * The auth injection is SELF-TUNING: Translink's licence decides whether the key is a query
 * param or a header, and the spec was ambiguous, so we build BOTH forms and let the client try
 * the primary then fall back to the alternate on an auth rejection (it pins + logs whichever
 * works). Set TRANSLINK_AUTH_MODE once the logs reveal the answer to skip the probe.
 *   - TRANSLINK_AUTH_MODE = query (default) | header   → the primary (tried first)
 *   - query param name  from TRANSLINK_AUTH_PARAM  (default "key")
 *   - header name       from TRANSLINK_AUTH_HEADER (default "Authorization")
 *   - TRANSLINK_DEBUG=1 logs the raw (truncated) EFA JSON so a deploy can confirm the shape.
 */
function loadTransitConfig(): EfaConfig | null {
  const value = process.env.TRANSLINK_API_KEY;
  if (!value) return null;
  const baseUrl = process.env.TRANSLINK_API_BASE ?? TRANSLINK_DEFAULT_BASE;
  const mode = process.env.TRANSLINK_AUTH_MODE === "header" ? "header" : "query";
  const paramName = process.env.TRANSLINK_AUTH_PARAM ?? "key";
  const headerName = process.env.TRANSLINK_AUTH_HEADER ?? "Authorization";

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

/**
 * Allowed browser origins for CORS. Comma-separated CORS_ALLOWED_ORIGINS in prod;
 * sensible local Next origins (3000/3001) in dev. Read once at boot.
 */
const allowedOrigins: string[] = (
  process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:3000,http://localhost:3001"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

/** Build the CORS headers for a given request origin (echo it only if allowed). */
function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-internal-call",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && allowedOrigins.includes(origin)) {
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
  if (pathname === "/jobs/deliver-birthdays") {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, cors);
    }
    const ctx = createContext({ headers: toHeaderBag(request.headers) });
    if (!ctx.isInternalCall) {
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

  // Internal cron route: sync Awin affiliate offers into awin_deals. Same internal-secret gate as
  // the birthday route; dormant when AWIN_API_KEY is unset (returns "unconfigured", not an error).
  // Triggered by pg_cron on a schedule; idempotent (upsert-by-promotion-id).
  if (pathname === "/jobs/sync-awin-offers") {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, cors);
    }
    const ctx = createContext({ headers: toHeaderBag(request.headers) });
    if (!ctx.isInternalCall) {
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
      type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
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
          .select("id, product_id, quantity")) as {
          data: { id: string; product_id: string | null; quantity: number }[] | null;
        };
        const order = updated?.[0];
        if (order?.product_id) {
          const { data: prod } = (await service
            .from("venue_products")
            .select("stock")
            .eq("id", order.product_id)
            .maybeSingle()) as { data: { stock: number | null } | null };
          if (prod && prod.stock != null) {
            await service
              .from("venue_products")
              .update({ stock: Math.max(0, prod.stock - order.quantity) })
              .eq("id", order.product_id);
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
