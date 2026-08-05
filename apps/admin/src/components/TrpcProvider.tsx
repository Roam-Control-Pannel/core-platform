/**
 * tRPC provider for Roam HQ.
 *
 * Builds the typed client with a getAccessToken that reads the live Supabase session,
 * and exposes it via React context. Tracks the session so the token forwarded to the API
 * stays current across sign-in/out. Unlike the consumer surfaces, Roam HQ has no valid
 * anonymous state — a null session means "sign in", and even a signed-in non-staff user
 * is refused by the API (adminProcedure), surfaced as the not-authorised screen.
 */
"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { makeTrpcClient, type TrpcClient } from "../lib/trpc";
import { getSupabaseBrowser } from "../lib/supabase";

const TrpcContext = createContext<TrpcClient | null>(null);
const SessionContext = createContext<Session | null>(null);

export function TrpcProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

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

/** Get the live Supabase session (or null when signed out). Read inside <TrpcProvider>. */
export function useSession(): Session | null {
  return useContext(SessionContext);
}
