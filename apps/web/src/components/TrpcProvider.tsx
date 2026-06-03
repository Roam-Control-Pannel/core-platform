/**
 * tRPC provider for the web surface.
 *
 * Builds the typed client (from the shell's makeTrpcClient) with a getAccessToken that
 * reads the live Supabase session, and exposes it via React context. Components call
 * useTrpc() to get the typed client and issue queries. Tracks the session so the token
 * forwarded to the API stays current across sign-in/out (just-in-time auth: null token
 * is valid — public browsing works).
 *
 * This is the data-layer seam every web screen reuses; Explore is its first consumer.
 */
"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { makeTrpcClient, type TrpcClient } from "../lib/trpc";
import { getSupabaseBrowser } from "../lib/supabase";

const TrpcContext = createContext<TrpcClient | null>(null);

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

  return <TrpcContext.Provider value={client}>{children}</TrpcContext.Provider>;
}

/** Get the typed tRPC client. Throws if used outside the provider. */
export function useTrpc(): TrpcClient {
  const client = useContext(TrpcContext);
  if (!client) throw new Error("useTrpc must be used within <TrpcProvider>.");
  return client;
}
