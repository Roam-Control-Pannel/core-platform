/**
 * The web shell's first middleware — Food to Go marketplace host resolution.
 *
 * The API is host-blind (Shape B), so the WEB layer decides which branded channel a request is on
 * from its hostname. We classify the host to a channel key and:
 *   - set the `roam_channel` cookie (non-httpOnly) so the browser tRPC client forwards it as
 *     `x-roam-channel` on every call, and the ChannelProvider can theme + branch the shell;
 *   - forward `x-roam-channel` on the onward request headers so server components / the web's own
 *     /api proxy routes can read the active channel too.
 *
 * Host resolution is CONFIG-DRIVEN (see lib/channelMap.ts): the env classifier handles the known
 * dev/env hosts instantly, and any other host is looked up against the DB `channel_domains` map via
 * the CDN-cached /api/channel-map endpoint, so onboarding a whitelabel domain is a row, not a
 * redeploy. Resolution is fail-open — an unmapped host or a lookup blip resolves to the default
 * (Roam) channel. The API's `channels.current` (also `channel_domains`-backed) stays authoritative
 * for theming; a mis-hint here only picks the wrong chrome for one render.
 */
import { NextResponse, type NextRequest } from "next/server";
import { CHANNEL_COOKIE, DEFAULT_CHANNEL_KEY } from "./lib/channel";
import { resolveChannelKey } from "./lib/channelMap";

/**
 * Paths that belong to the Roam experience only and must not render under a brand channel's chrome.
 * `/explore` is Roam's place-anchored browse (all categories, City-of-London default) — a brand
 * storefront has its own discovery at `/`, so on a brand channel these redirect there. Kept narrow
 * on purpose: routes a storefront legitimately shares (e.g. /orders, /business) are NOT listed.
 */
function isRoamOnlyPath(pathname: string): boolean {
  return pathname === "/explore" || pathname.startsWith("/explore/");
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const channelKey = await resolveChannelKey(req.nextUrl.origin, host);

  // Food to Go is a self-contained storefront: its discovery surface is the storefront home (/),
  // not Roam's place-anchored /explore (which defaults to City of London and shows every category).
  // A brand channel must never fall through to that generic browse, so redirect /explore to the
  // storefront home. Server-side here so it catches direct URLs and history, not just in-app links.
  if (channelKey !== DEFAULT_CHANNEL_KEY && isRoamOnlyPath(req.nextUrl.pathname)) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  // Forward the resolved channel on the onward request headers.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-roam-channel", channelKey);

  const res = NextResponse.next({ request: { headers: requestHeaders } });

  // Refresh the cookie only when it drifts, to avoid a Set-Cookie on every request.
  if (req.cookies.get(CHANNEL_COOKIE)?.value !== channelKey) {
    res.cookies.set(CHANNEL_COOKIE, channelKey, {
      path: "/",
      sameSite: "lax",
      httpOnly: false,
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  return res;
}

/**
 * Run on page/document requests only — skip Next internals, static assets, and any path with a
 * file extension. `/api/channel-map` is excluded too: the resolver fetches it, so letting middleware
 * run on it would recurse. The channel just needs resolving once per navigation, not per asset.
 */
export const config = {
  matcher: ["/((?!_next/|api/channel-map|favicon\\.ico|.*\\.[\\w]+$).*)"],
};
