/**
 * Native Supabase client — the session source for the native surface.
 *
 * Mirrors web's lib/supabase.ts (anon key + public URL only; the service-role key
 * NEVER reaches a client), with the platform difference that matters: there is no
 * browser to persist the session, so we give Supabase an expo-secure-store storage
 * adapter. The session holds the access + refresh tokens — credentials — so they go
 * in the OS keychain (secure-store), never AsyncStorage (plaintext, wrong for tokens).
 *
 * Config comes from app.json's extra (the same place trpc.ts reads apiUrl), so the
 * native shell has one config source. Anonymous is valid — public Discover browses
 * with no session (just-in-time auth: the gate is per-action, not per-app).
 *
 * autoRefreshToken + persistSession are ON here (unlike web's provider, which leans on
 * the browser): native must refresh the token itself and rehydrate the session from the
 * keychain on cold start, which is exactly what unlocks "stay signed in across launches".
 */
import "react-native-url-polyfill/auto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";

/** expo-secure-store as a Supabase auth storage adapter (get/set/remove by key). */
const SecureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

interface SupabaseExtra {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

let client: SupabaseClient | null = null;

/** Lazily create a singleton native Supabase client backed by secure-store. */
export function getSupabaseNative(): SupabaseClient {
  if (client) return client;
  const extra = Constants.expoConfig?.extra as SupabaseExtra | undefined;
  const url = extra?.supabaseUrl;
  const anon = extra?.supabaseAnonKey;
  if (!url || !anon) {
    throw new Error(
      "app.json extra.supabaseUrl and extra.supabaseAnonKey must be set (see apps/native/app.json).",
    );
  }
  client = createClient(url, anon, {
    auth: {
      storage: SecureStoreAdapter,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
  return client;
}
