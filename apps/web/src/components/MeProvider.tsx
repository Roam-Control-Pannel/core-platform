/**
 * MeProvider — fetches the signed-in user's own profile (profiles.me) ONCE per page load and shares
 * it via context, so the chrome (TopBar avatar, SideNav profile card) reads one source instead of
 * each fetching separately. Reactive to the session: clears on sign-out, refetches on sign-in.
 */
"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useTrpc, useSession } from "./TrpcProvider";

export interface OwnedVenue {
  id: string;
  name: string;
  slug: string | null;
  status: string | null;
}

export interface Me {
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /** Businesses this user has claimed — drives the owner-aware "My businesses" nav. */
  ownedVenues: OwnedVenue[];
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
    const q = trpc.profiles.me as unknown as { query: () => Promise<Partial<Me> & Omit<Me, "ownedVenues">> };
    // Default ownedVenues to [] so the chrome renders correctly during the API redeploy window,
    // before the extended `me` payload is live.
    q.query().then((p) => { if (live) setMe({ ...p, ownedVenues: p.ownedVenues ?? [] }); }).catch(() => {});
    return () => { live = false; };
  }, [trpc, session]);

  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

/** The signed-in user's own profile (handle/displayName/avatarUrl), or null when signed out / loading. */
export function useMe(): Me | null {
  return useContext(MeContext);
}
