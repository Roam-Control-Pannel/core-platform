/**
 * Browser Supabase client — the session source for the web surface.
 *
 * Uses ONLY the public env (NEXT_PUBLIC_SUPABASE_URL + anon key) — safe in the browser
 * bundle. This holds the user's auth session; the tRPC provider reads its access token
 * and forwards it to the API so RLS sees the right auth.uid(). Anonymous is fine —
 * Explore browses public/unclaimed venues with no session (just-in-time auth).
 *
 * Never import the service-role key here — that is a server-only secret (see .env.example).
 */
"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/** Lazily create a singleton browser client. */
export function getSupabaseBrowser(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set (see .env.example).",
    );
  }
  client = createClient(url, anon);
  return client;
}
