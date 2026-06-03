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
 * Env is read ONCE at module load and fail-fast: a missing secret should crash the
 * service at boot, not silently degrade auth at request time.
 */
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./routers/index.js";
import { makeContextFactory, type ApiEnv, type HeaderBag } from "./context.js";

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
  };
}

const createContext = makeContextFactory(loadEnv());

/** Adapt a standard fetch Headers object to our transport-agnostic HeaderBag. */
function toHeaderBag(headers: Headers): HeaderBag {
  return { get: (name: string) => headers.get(name) };
}

/**
 * The fetch handler. Point any fetch-native runtime at this.
 *   export default { fetch: handler }   // edge / Bun / Deno
 *   // or wrap in a Netlify Function that forwards (request) => handler(request)
 */
export function handler(request: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: "/trpc",
    req: request,
    router: appRouter,
    createContext: () => createContext({ headers: toHeaderBag(request.headers) }),
  });
}
