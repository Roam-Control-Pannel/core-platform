/**
 * SERVER-ONLY tRPC client for trusted internal calls to the API.
 *
 * This is the web app's server-to-server hop: a Route Handler (the only legitimate
 * caller) uses it to reach the API's internalProcedure surface — procedures that
 * require the x-internal-call secret and run with the service role. The browser can
 * NEVER construct or call this: it reads INTERNAL_CALL_SECRET, an UNPREFIXED env var
 * that Next keeps server-only — unprefixed vars are NEVER inlined into the client
 * bundle (the prefix rule is the actual firewall, enforced by Next). This module is
 * only ever imported by the server-side ingest Route Handler. If it were pulled into
 * a Client Component the secret would read undefined and the call-time guard below
 * would throw — a backstop, not the primary boundary.
 *
 * Same transport as the browser client (lib/trpc.ts): createTRPCClient + httpBatchLink
 * to ${NEXT_PUBLIC_API_URL}/trpc, type-only AppRouter import so no server code from
 * @roam/api crosses the boundary. The ONLY difference is the header: this attaches
 * x-internal-call instead of a user Bearer token. We do not hand-roll the tRPC HTTP
 * envelope — the client builds it correctly by construction.
 *
 * Env resolution is at CALL time, not module-eval (matches lib/trpc.ts: never throw at
 * build/import time just because a runtime var isn't present during static analysis).
 * A missing secret throws a clear server-side error when an ingest is actually attempted.
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@roam/api";

/** Resolve the API base origin. Same var the browser client uses; local dev → :8787. */
function apiUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
}

/**
 * Build the internal client. The secret is read here (call time) and the access is
 * isolated so a missing value fails loudly at the point of use, not at import.
 */
export function makeInternalTrpcClient() {
  const secret = process.env.INTERNAL_CALL_SECRET;
  if (!secret) {
    throw new Error(
      "INTERNAL_CALL_SECRET is not set in the server environment. The internal " +
        "ingest call cannot be authenticated. Check the root .env and that " +
        "scripts/sync-env.mjs has run (predev/prebuild hook).",
    );
  }
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${apiUrl()}/trpc`,
        headers() {
          return { "x-internal-call": secret };
        },
      }),
    ],
  });
}
