/**
 * ChannelTheme — applies the active channel's branding to the web shell.
 *
 * Mounted once in the root layout (inside TrpcProvider). It asks the API which channel the caller
 * is on — `channels.current`, resolved from the `x-roam-channel` header the tRPC client forwards
 * from the cookie the middleware set — and applies that channel's validated theme tokens to the
 * document root. On the default channel this is a no-op restore of the base Roam palette.
 *
 * Client-side by design: the layout stays statically cacheable (the same reason i18n is
 * client-first here — see LocaleProvider). A brief first-paint on the base palette before the swap
 * is acceptable for a dormant seam; SSR injection can replace this later without touching core.
 */
"use client";

import { useEffect } from "react";
import { useTrpc } from "./TrpcProvider";
import { applyChannelTheme } from "../lib/channel";

export function ChannelTheme() {
  const trpc = useTrpc();

  useEffect(() => {
    let cancelled = false;
    trpc.channels.current
      .query()
      .then((channel) => {
        if (cancelled || !channel) return;
        applyChannelTheme(document.documentElement, channel.key, channel.theme);
      })
      .catch(() => {
        /* themeing is best-effort; the base palette is a fine fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  return null;
}
