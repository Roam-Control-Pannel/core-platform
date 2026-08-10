/**
 * Web-side channel plumbing for the Food to Go marketplace's "one platform, two views".
 *
 * The API is Shape-B (standalone, keyed by JWT, host-blind). So the WEB shell owns host
 * resolution: middleware classifies the incoming hostname to a channel key, drops it in a cookie,
 * and the tRPC client forwards it as `x-roam-channel`. The API then filters/themes by that key.
 *
 * Browser-safe MIRROR, by the same rule as VenueCard's formatDistance and lib/chatKinds: the web
 * bundle deliberately does not import @roam/core (a Node-ESM package that drags @roam/db into the
 * client). The canonical host→channel map + theme validation live in core/the API; this file is
 * only a fast classifier + the CSS-var apply, kept tiny and dependency-free. The API's
 * `channels.current` (backed by `channel_domains`) stays AUTHORITATIVE — a wrong hint here simply
 * resolves back to the default channel there.
 */

/** Semantic theme tokens a channel may override — mirror of @roam/core/channels' ChannelTheme. */
export interface ChannelTheme {
  brand?: string;
  accent?: string;
  paper?: string;
  ink?: string;
}

/** The default channel's key: the unbranded, everything-included view. */
export const DEFAULT_CHANNEL_KEY = "roam";

/** Cookie the middleware sets and the tRPC client reads (non-httpOnly: the client must send it). */
export const CHANNEL_COOKIE = "roam_channel";

/**
 * Reduce a raw Host / X-Forwarded-Host value to the bare lowercased hostname (no scheme, port,
 * path or trailing dot). Mirror of @roam/core/channels.normalizeHost — kept in lockstep by tests.
 */
export function normalizeHost(raw: string | null | undefined): string {
  if (!raw) return "";
  let h = raw.trim().toLowerCase();
  if (h.includes(",")) h = h.split(",")[0]!.trim();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  h = h.replace(/[/?#].*$/, "");
  h = h.replace(/:\d+$/, "");
  h = h.replace(/\.$/, "");
  return h;
}

/**
 * The host→channel map the classifier consults: built-in dev hosts plus any production hosts in
 * NEXT_PUBLIC_F2G_HOSTS (comma-separated). Mirrors the seed in migration 0116; production hosts
 * live in env so a new storefront domain needs no code change.
 */
function f2gHosts(): Set<string> {
  const hosts = new Set<string>(["f2g.local", "food.local"]);
  const extra = process.env.NEXT_PUBLIC_F2G_HOSTS;
  if (extra) {
    for (const h of extra.split(",")) {
      const host = normalizeHost(h);
      if (host) hosts.add(host);
    }
  }
  return hosts;
}

/**
 * Classify a raw Host value to a channel key. Explicit map wins; otherwise a `f2g.`/`food.`
 * subdomain is treated as Food to Go; everything else is the default channel.
 */
export function channelKeyForHost(rawHost: string | null | undefined): string {
  const host = normalizeHost(rawHost);
  if (!host) return DEFAULT_CHANNEL_KEY;
  if (f2gHosts().has(host)) return "f2g";
  if (host.startsWith("f2g.") || host.startsWith("food.")) return "f2g";
  return DEFAULT_CHANNEL_KEY;
}

/** Read the channel-key cookie in the browser (null on the server or when unset). */
export function readChannelCookie(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)roam_channel=([^;]+)/);
  const value = m?.[1];
  return value ? decodeURIComponent(value) : null;
}

/** Semantic channel token → the @roam/design CSS variable it overrides. */
const CSS_VAR: Record<keyof ChannelTheme, string> = {
  brand: "--crimson",
  accent: "--gold",
  paper: "--paper",
  ink: "--ink",
};

/**
 * Apply a channel's theme to a root element: stamp `data-channel` for CSS hooks and override only
 * the vars the channel actually sets (clearing any it doesn't, so switching back to the default
 * channel fully restores the base Roam palette). Values are already hex-validated by the API.
 */
export function applyChannelTheme(
  root: HTMLElement,
  channelKey: string,
  theme: ChannelTheme,
): void {
  root.dataset.channel = channelKey;
  for (const [key, cssVar] of Object.entries(CSS_VAR) as [keyof ChannelTheme, string][]) {
    const value = theme[key];
    if (value) root.style.setProperty(cssVar, value);
    else root.style.removeProperty(cssVar);
  }
}
