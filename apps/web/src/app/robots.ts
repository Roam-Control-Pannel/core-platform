/**
 * robots.txt (generated). Allows crawling of the public surfaces and blocks the private,
 * per-user ones (account, social graph, chats, plans, the owner dashboard) plus the API route
 * handler — none of which should ever appear in search results. Points crawlers at the sitemap.
 *
 * Domain comes from NEXT_PUBLIC_SITE_URL via lib/seo (localhost fallback for dev).
 */
import type { MetadataRoute } from "next";
import { siteUrl } from "../lib/seo";

export default function robots(): MetadataRoute.Robots {
  const base = siteUrl();
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/account", "/following", "/friends", "/notifications", "/threads", "/plans", "/dashboard", "/api/"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
