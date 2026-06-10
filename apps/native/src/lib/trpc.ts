/**
 * Typed tRPC client for the native surface.
 *
 * Mirrors the web client (makeTrpcClient) but reads the API origin from
 * app.json's extra.apiUrl via expo-constants, with a localhost:8787 fallback.
 * Imports ONLY `type AppRouter` from @roam/api — no server code bundles in.
 *
 * getAccessToken returns null for now: chunk 3 is read-only public Discover
 * (venues.near is publicProcedure). Supabase session wiring is a later slice.
 * Never throws at module-eval; an unreachable API fails at call time and the
 * screen shows its error state.
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import Constants from "expo-constants";
import type { AppRouter } from "@roam/api";

function apiUrl(): string {
  const extra = Constants.expoConfig?.extra as { apiUrl?: string } | undefined;
  return extra?.apiUrl ?? "http://localhost:8787";
}

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
