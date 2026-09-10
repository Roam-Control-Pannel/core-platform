/**
 * ChannelProvider / useChannel — publishes the active brand channel to the whole client tree.
 *
 * Phase 0 gave us host→channel resolution (middleware sets the roam_channel cookie + x-roam-channel
 * header) and ChannelTheme applied the palette. Phase 2 needs whole PAGES and chrome to branch on
 * the channel (the f2g storefront home vs the Roam home), so we lift that into one context:
 *
 *   - Instant: `readChannelCookie()` gives the channel KEY with no round-trip, so chrome can pick
 *     its `surface` from the first post-hydration tick (via a small key→surface bootstrap map,
 *     below), before the authoritative read confirms it from the DB.
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
import {
  applyChannelTheme,
  readChannelCookie,
  isSectionEnabled,
  DEFAULT_CHANNEL_KEY,
  type ChannelNavItem,
  type ChannelSections,
  type ChannelSurface,
} from "../lib/channel";

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
  /** The channel's own header nav; [] = use the surface's default chrome nav. */
  nav: ChannelNavItem[];
  /** Explicit allow-map of exposed surfaces; read via `isSectionEnabled`. */
  sections: ChannelSections;
  /** Which shell chrome to render ('roam' rail vs 'storefront' header). */
  surface: ChannelSurface;
}

export interface ChannelState {
  /** The active channel key ("roam" | "f2g" | …). */
  key: string;
  /**
   * Which shell chrome to render — the channel-config replacement for the old per-channel boolean
   * dispatch (review debt D3). Set instantly from the cookie bootstrap map, then confirmed from the
   * DB. Chrome branches on `surface === "storefront"`.
   */
  surface: ChannelSurface;
  /** Whether the active channel exposes a named top-level surface (explicit allow-map). */
  isEnabled: (section: string) => boolean;
  /** The full channel (name, theme, logo, nav, sections) once resolved; null before that. */
  channel: ChannelInfo | null;
  /** True once the channel has been resolved (cookie + authoritative read settled). */
  resolved: boolean;
}

const DEFAULT_STATE: ChannelState = {
  key: DEFAULT_CHANNEL_KEY,
  surface: "roam",
  isEnabled: () => false,
  channel: null,
  resolved: false,
};

/**
 * Instant key→surface for the pre-network paint, so a storefront channel renders its chrome from
 * the first tick instead of flashing the Roam rail while the authoritative read is in flight. This
 * is the ONE remaining place the web hardcodes a channel's surface; it's a bootstrap hint only (the
 * DB value below is authoritative) and goes away once middleware carries `surface` in the cookie
 * (deferred slice A2-middleware).
 */
function bootstrapSurface(key: string): ChannelSurface {
  return key === "f2g" ? "storefront" : "roam";
}

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
      setState((s) => ({ ...s, key: cookieKey, surface: bootstrapSurface(cookieKey) }));
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
        const channel = ch as ChannelInfo;
        setState({
          key: channel.key,
          surface: channel.surface,
          isEnabled: (section: string) => isSectionEnabled(channel.sections, section),
          channel,
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

/** The active brand channel. Branch chrome on `surface`, surfaces on `isEnabled`; gate flashes on `resolved`. */
export function useChannel(): ChannelState {
  return useContext(ChannelContext);
}
