import type { NextConfig } from "next";

/**
 * The shared packages (@roam/design, @roam/api types, @roam/db) ship as TypeScript
 * SOURCE, not built JS (the workspace's source-resolution convention). Next must
 * transpile them rather than expecting pre-built dist output.
 *
 * Env: the monorepo-root .env is the single source of truth. Turbopack inlines
 * NEXT_PUBLIC_* from its native app-dir .env discovery, so a committed predev/prebuild
 * script (scripts/sync-env.mjs) generates apps/web/.env.local with ONLY the public vars
 * from root .env before each run. See that script for the full rationale.
 */
const nextConfig: NextConfig = {
  transpilePackages: ["@roam/design", "@roam/api", "@roam/db"],
  reactStrictMode: true,
};

export default nextConfig;
