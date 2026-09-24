/**
 * robots.txt (generated, per channel — A3-b). Allows crawling of the public surfaces and blocks the
 * private, per-user ones (account, social graph, chats, plans, the owner dashboard) plus the API route
 * handler — none of which should ever appear in search results. Points crawlers at THIS host's sitemap.
 *
 * Channel-aware: on a branded whitelabel host (Food to Go) the sitemap + host resolve to that channel's
 * own canonical origin (channelBaseUrl), so the storefront advertises its own sitemap rather than Roam's.
 * The default channel (and an unresolved read) fall back to the Roam origin, unchanged. Reading the
 * channel (via x-roam-channel) opts this route into dynamic rendering — correct for per-host robots.
 */
import type { MetadataRoute } from "next";
import { channelBaseUrl } from "../lib/seo";
import { serverChannelKey } from "../lib/serverApi";

// Reads x-roam-channel → dynamic (per-host robots), consistent with the sitemap + root metadata.
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const base = channelBaseUrl(await serverChannelKey());
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // `/admin-login` and `/association` are a partner organisation's private entrance and portal.
        // Neither was listed before, which left a sign-in page for a handful of named officers in the
        // crawlable set. Both pages also carry a noindex meta tag, for crawlers that arrive by link.
        disallow: [
          "/account", "/following", "/friends", "/notifications", "/threads", "/plans", "/dashboard",
          "/admin-login", "/association", "/activate", "/f2g/claim", "/api/",
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
