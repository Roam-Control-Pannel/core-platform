/**
 * Typed tRPC client for the web shell.
 *
 * Imports ONLY `type AppRouter` from @roam/api — no server code crosses into the
 * browser bundle (the api barrel is arranged so this is type-only). The client points
 * at the standalone API service (Shape B) via NEXT_PUBLIC_API_URL, and attaches the
 * caller's Supabase JWT as the Authorization header so the API builds an RLS-scoped
 * client for the right user. Anonymous (no token) is fine — public browsing works.
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@roam/api";

/** Resolve the API base URL from public env; fail loudly in dev if missing. */
function apiUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_API_URL is not set. Point it at the Roam API service (see .env.example).",
    );
  }
  return url;
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
