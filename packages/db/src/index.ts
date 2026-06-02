/**
 * @roam/db — the typed Supabase client layer.
 *
 * TWO clients, kept deliberately separate so the dangerous one is never reached
 * for by accident:
 *
 *   createUserClient()    — anon key + the caller's JWT. RLS ENFORCED. This is what
 *                           every shell (web/console/native) uses. A user can only
 *                           ever touch rows their RLS policies permit.
 *
 *   createServiceClient() — service-role key. RLS BYPASSED. Server-to-server ONLY
 *                           (Edge Functions, Stripe webhook, cron). NEVER ship this
 *                           key to a browser or native bundle. Guarded below.
 *
 * The generated `Database` type makes every query column-checked against the real
 * schema. Regenerate it with `pnpm db:types` after any migration.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./generated/database.types.js";

export type RoamClient = SupabaseClient<Database>;
export type { Database } from "./generated/database.types.js";

/** Public config — safe to expose to clients. */
export interface PublicSupabaseConfig {
  url: string;
  anonKey: string;
}

/**
 * RLS-enforced client bound to a specific user's access token.
 * Pass the caller's JWT (from their session) so RLS sees `auth.uid()`.
 * With no token it behaves as the anonymous role — correct for public browsing
 * (e.g. unclaimed venues, which are world-readable by design).
 */
export function createUserClient(
  config: PublicSupabaseConfig,
  accessToken?: string,
): RoamClient {
  return createClient<Database>(config.url, config.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: accessToken
      ? { headers: { Authorization: `Bearer ${accessToken}` } }
      : {},
  });
}

/**
 * Service-role client. RLS bypassed — use ONLY in trusted server contexts.
 *
 * Hard guard: refuses to construct if it detects a browser-like global, so a
 * service key can never silently power a client bundle. This is a backstop, not
 * a substitute for keeping the key out of client env in the first place.
 */
export function createServiceClient(config: {
  url: string;
  serviceRoleKey: string;
}): RoamClient {
  if (typeof window !== "undefined") {
    throw new Error(
      "[@roam/db] createServiceClient called in a browser context. " +
        "The service-role key bypasses RLS and must never reach the client. " +
        "Use createUserClient in shells; reserve service-role for server-to-server.",
    );
  }
  return createClient<Database>(config.url, config.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
