/**
 * tRPC + session provider for the native surface. Mirrors web's TrpcProvider contract
 * exactly (track session -> rebuild client on token change -> expose useTrpc/useSession),
 * differing only in the session source: native's secure-store-backed getSupabaseNative
 * instead of web's browser client. The contract is identical so a screen reasons about
 * auth the same way on both surfaces (one mental model, the architecture's whole point).
 *
 * Just-in-time auth: a null session is VALID (public Discover browses with no token).
 * The token feeds makeTrpcClient's getAccessToken; when it changes (sign in/out/refresh)
 * the client is rebuilt so every request carries the live JWT. On cold start the session
 * rehydrates from the keychain (getSession), so a signed-in user stays signed in.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { makeTrpcClient, type TrpcClient } from "./trpc";
import { getSupabaseNative } from "./supabase";

const TrpcContext = createContext<TrpcClient | null>(null);
/** Session context: null when signed out (valid — public browsing works). */
const SessionContext = createContext<Session | null>(null);

export function TrpcProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    const supabase = getSupabaseNative();
    // Rehydrate the current session from the keychain, then subscribe to changes.
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
 * null is a valid state (public browsing), never an error.
 */
export function useSession(): Session | null {
  return useContext(SessionContext);
}
