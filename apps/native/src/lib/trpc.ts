/**
 * Typed tRPC client for the native surface.
 *
 * Mirrors the web client (makeTrpcClient) but reads the API origin from
 * app.json's extra.apiUrl via expo-constants, with a localhost:8787 fallback.
 * Imports ONLY `type AppRouter` from @roam/api — no server code bundles in.
 *
 * getAccessToken is read live at request time (returns a Promise) so every call
 * carries the current JWT regardless of React render timing — no stale-closure
 * race when a just-in-time sign-in resumes a gated action.
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

export function makeTrpcClient(getAccessToken: () => Promise<string | null>) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${apiUrl()}/trpc`,
        async headers() {
          const token = await getAccessToken();
          return token ? { authorization: `Bearer ${token}` } : {};
        },
      }),
    ],
  });
}

export type TrpcClient = ReturnType<typeof makeTrpcClient>;
