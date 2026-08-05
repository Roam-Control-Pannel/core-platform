/**
 * Typed tRPC client for Roam HQ (the admin surface).
 *
 * Imports ONLY `type AppRouter` from @roam/api — no server code crosses into the
 * browser bundle. The client points at the standalone API service via NEXT_PUBLIC_API_URL
 * and attaches the caller's Supabase JWT so the API can verify Roam HQ membership
 * (adminProcedure) and, only then, escalate to a service-role read on the server. The
 * service-role key never touches this bundle.
 *
 * Env handling: NEXT_PUBLIC_API_URL resolves with a safe localhost fallback and NEVER
 * throws at build/module-eval time — an unreachable API fails at call time and the
 * screen shows its error state.
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
