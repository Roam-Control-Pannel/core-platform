/**
 * tRPC + session provider for the native surface. Mirrors web's TrpcProvider contract
 * exactly (track session -> rebuild client on token change -> expose useTrpc/useSession),
 * differing only in the session source: native's secure-store-backed getSupabaseNative
 * instead of web's browser client. The contract is identical so a screen reasons about
 * auth the same way on both surfaces (one mental model, the architecture's whole point).
 *
 * Just-in-time auth: a null session is VALID (public Discover browses with no token).
 * The client is built ONCE; its getAccessToken reads the live session from the Supabase
 * singleton at request time, so every request carries the current JWT with no rebuild
 * timing to get wrong — a sign-in that resumes a gated action is authed immediately.
 * The session state below still drives useSession() (the UI auth gate); it just no
 * longer gates the client. On cold start the session rehydrates from the keychain.
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

  // Build the client once. getAccessToken reads the live session at request time, so
  // there's no stale-closure race when a just-in-time sign-in resumes a gated action.
  const client = useMemo(
    () =>
      makeTrpcClient(async () => {
        const { data } = await getSupabaseNative().auth.getSession();
        return data.session?.access_token ?? null;
      }),
    [],
  );

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
