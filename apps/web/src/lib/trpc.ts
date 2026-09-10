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
import { readChannelCookie } from "./channel";

/** Resolve the API base origin. Falls back to local dev; never throws. */
function apiUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
}

/**
 * Build a tRPC client. Pass a function that returns the current access token (from the
 * Supabase session) so each request carries the live JWT; returns null when signed out.
 *
 * `getChannel` supplies the active channel key. It defaults to the browser cookie reader
 * (`readChannelCookie`), which is correct in the client bundle but returns null on the server
 * (there is no document). Server-side callers (SEO reads in serverApi.ts) pass a getter backed
 * by `next/headers` instead, so server renders resolve the right channel rather than always
 * falling back to the default Roam channel — the D2 fix.
 */
export function makeTrpcClient(
  getAccessToken: () => string | null,
  getChannel: () => string | null = readChannelCookie,
) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${apiUrl()}/trpc`,
        headers() {
          const token = getAccessToken();
          const channel = getChannel();
          const h: Record<string, string> = {};
          if (token) h.authorization = `Bearer ${token}`;
          // The active channel (Food to Go vs Roam). Set by middleware; forwarded so the API
          // themes/filters by it. Absent = the API defaults to the Roam channel.
          if (channel) h["x-roam-channel"] = channel;
          return h;
        },
      }),
    ],
  });
}

export type TrpcClient = ReturnType<typeof makeTrpcClient>;
