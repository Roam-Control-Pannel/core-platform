/**
 * tRPC provider for the web surface.
 *
 * Builds the typed client (from the shell's makeTrpcClient) with a getAccessToken that
 * reads the live Supabase session, and exposes it via React context. Components call
 * useTrpc() to get the typed client and issue queries. Tracks the session so the token
 * forwarded to the API stays current across sign-in/out (just-in-time auth: null token
 * is valid — public browsing works).
 *
 * Also exposes the live session via useSession(), so screens can gate write-paths on
 * auth state (e.g. the claim flow: signed-out users get the JIT auth prompt, signed-in
 * users submit directly). The session is the SAME source the client's token reads from,
 * so the two never drift.
 *
 * This is the data-layer seam every web screen reuses; Explore is its first consumer.
 */
"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { makeTrpcClient, type TrpcClient } from "../lib/trpc";
import { getSupabaseBrowser } from "../lib/supabase";

const TrpcContext = createContext<TrpcClient | null>(null);
/** Session context: null when signed out (valid — public browsing works). */
const SessionContext = createContext<Session | null>(null);

export function TrpcProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    // Seed current session, then subscribe to changes.
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Rebuild the client when the token changes so requests carry the live JWT.
  const token = session?.access_token ?? null;
  const client = useMemo(() => makeTrpcClient(() => token), [token]);

  return (
    <TrpcContext.Provider value={client}>
      <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
    </TrpcContext.Provider>
  );
}

/** Get the typed tRPC client. Throws if used outside the provider. */
export function useTrpc(): TrpcClient {
  const client = useContext(TrpcContext);
  if (!client) throw new Error("useTrpc must be used within <TrpcProvider>.");
  return client;
}

/**
 * Get the live Supabase session (or null when signed out). Read inside <TrpcProvider>.
 * Returns null outside any session — callers treat null as "not signed in", which is a
 * valid state (public browsing), not an error.
 */
export function useSession(): Session | null {
  return useContext(SessionContext);
}
