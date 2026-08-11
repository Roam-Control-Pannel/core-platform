/**
 * ChannelProvider / useChannel — publishes the active brand channel to the whole client tree.
 *
 * Phase 0 gave us host→channel resolution (middleware sets the roam_channel cookie + x-roam-channel
 * header) and ChannelTheme applied the palette. Phase 2 needs whole PAGES and chrome to branch on
 * the channel (the f2g storefront home vs the Roam home), so we lift that into one context:
 *
 *   - Instant: `readChannelCookie()` gives the channel KEY with no round-trip, so components can
 *     branch on `isF2G` from the first post-hydration tick.
 *   - Authoritative: `channels.current` returns the full Channel (name, theme) and applies the
 *     palette — same call ChannelTheme used to make, now folded in here.
 *
 * SSR renders the default (Roam) branch — the layout is deliberately cookie-free/static — and the
 * real channel resolves just after mount. `resolved` lets a page hold a skeleton instead of
 * flashing the wrong home. This is the same client-first tradeoff LocaleProvider already accepts.
 */
"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useTrpc } from "./TrpcProvider";
import { applyChannelTheme, readChannelCookie, DEFAULT_CHANNEL_KEY } from "../lib/channel";

/** Mirror of the api Channel shape (web doesn't import @roam/core — see lib/channel.ts). */
export interface ChannelInfo {
  id: string;
  key: string;
  name: string;
  tagline: string | null;
  isDefault: boolean;
  theme: { brand?: string; accent?: string; paper?: string; ink?: string };
  logoUrl: string | null;
  /** 'open' shows all eligible venues near the point; 'members' shows only opted-in venues. */
  membershipMode: "open" | "members";
}

export interface ChannelState {
  /** The active channel key ("roam" | "f2g" | …). */
  key: string;
  /** Convenience: on the Food to Go storefront channel. */
  isF2G: boolean;
  /** The full channel (name, theme, logo) once the authoritative read lands; null before that. */
  channel: ChannelInfo | null;
  /** True once the channel has been resolved (cookie + authoritative read settled). */
  resolved: boolean;
}

const DEFAULT_STATE: ChannelState = {
  key: DEFAULT_CHANNEL_KEY,
  isF2G: false,
  channel: null,
  resolved: false,
};

const ChannelContext = createContext<ChannelState>(DEFAULT_STATE);

export function ChannelProvider({ children }: { children: ReactNode }) {
  const trpc = useTrpc();
  const [state, setState] = useState<ChannelState>(DEFAULT_STATE);

  useEffect(() => {
    let cancelled = false;

    // Instant branch from the cookie the middleware set (no network).
    const cookieKey = readChannelCookie() ?? DEFAULT_CHANNEL_KEY;
    if (!cancelled) {
      // Stamp data-channel immediately so channel-scoped CSS (e.g. full-width storefront) applies
      // before the authoritative theme read returns.
      if (typeof document !== "undefined") document.documentElement.dataset.channel = cookieKey;
      setState((s) => ({ ...s, key: cookieKey, isF2G: cookieKey === "f2g" }));
    }

    // Authoritative channel (name + theme). Applies the palette; ChannelTheme is folded in here.
    trpc.channels.current
      .query()
      .then((ch) => {
        if (cancelled) return;
        if (!ch) {
          setState((s) => ({ ...s, resolved: true }));
          return;
        }
        applyChannelTheme(document.documentElement, ch.key, ch.theme);
        setState({
          key: ch.key,
          isF2G: ch.key === "f2g",
          channel: ch as ChannelInfo,
          resolved: true,
        });
      })
      .catch(() => {
        if (!cancelled) setState((s) => ({ ...s, resolved: true }));
      });

    return () => {
      cancelled = true;
    };
  }, [trpc]);

  return <ChannelContext.Provider value={state}>{children}</ChannelContext.Provider>;
}

/** The active brand channel. Branch pages/chrome on `isF2G`; gate flashes on `resolved`. */
export function useChannel(): ChannelState {
  return useContext(ChannelContext);
}
