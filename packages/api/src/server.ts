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
  };
}

const createContext = makeContextFactory(loadEnv());

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
