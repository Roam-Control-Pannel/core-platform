/**
 * Typed tRPC client for the web surface.
 *
 * Imports ONLY `type AppRouter` from @roam/api — no server code crosses into the
 * browser bundle (the api barrel is arranged so this is type-only). The client points
 * at the standalone API service (Shape B) via NEXT_PUBLIC_API_URL, and attaches the
 * caller's Supabase JWT as the Authorization header so the API builds an RLS-scoped
 * client for the right user. Anonymous (no token) is fine — public browsing works.
 *
 * Env handling: NEXT_PUBLIC_API_URL is resolved with a safe localhost fallback and
 * NEVER throws at build/module-eval time. If it's unset or the API is unreachable, the
 * request fails at call time and the screen shows its error state — the build must not
 * crash just because a runtime env var isn't present during static analysis.
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@roam/api";

/** Resolve the API base origin. Falls back to local dev; never throws. */
function apiUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
}

/**
 * Build a tRPC client. Pass a function that returns the current access token (from the
 * Supabase session) so each request carries the live JWT; returns null when signed out.
 */
export function makeTrpcClient(getAccessToken: () => string | null) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${apiUrl()}/trpc`,
        headers() {
          const token = getAccessToken();
          return token ? { authorization: `Bearer ${token}` } : {};
        },
      }),
    ],
  });
}

export type TrpcClient = ReturnType<typeof makeTrpcClient>;
