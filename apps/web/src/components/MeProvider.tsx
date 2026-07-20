/**
 * MeProvider — fetches the signed-in user's own profile (profiles.me) ONCE per page load and shares
 * it via context, so the chrome (TopBar avatar, SideNav profile card) reads one source instead of
 * each fetching separately. Reactive to the session: clears on sign-out, refetches on sign-in.
 */
"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useTrpc, useSession } from "./TrpcProvider";

export interface Me {
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

const MeContext = createContext<Me | null>(null);

export function MeProvider({ children }: { children: React.ReactNode }) {
  const trpc = useTrpc();
  const session = useSession();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    if (!session) {
      setMe(null);
      return;
    }
    let live = true;
    const q = trpc.profiles.me as unknown as { query: () => Promise<Me> };
    q.query().then((p) => { if (live) setMe(p); }).catch(() => {});
    return () => { live = false; };
  }, [trpc, session]);

  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

/** The signed-in user's own profile (handle/displayName/avatarUrl), or null when signed out / loading. */
export function useMe(): Me | null {
  return useContext(MeContext);
}
