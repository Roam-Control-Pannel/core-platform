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
 * This is a fast classifier only (see lib/channel.ts). The DB-backed `channel_domains` map remains
 * the authority via the API; a mis-hint just resolves back to the default channel there.
 */
import { NextResponse, type NextRequest } from "next/server";
import { channelKeyForHost, CHANNEL_COOKIE } from "./lib/channel";

export function middleware(req: NextRequest): NextResponse {
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const channelKey = channelKeyForHost(host);

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
 * file extension. The channel just needs resolving once per navigation, not per asset.
 */
export const config = {
  matcher: ["/((?!_next/|favicon\\.ico|.*\\.[\\w]+$).*)"],
};
