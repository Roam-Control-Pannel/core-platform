import type { NextConfig } from "next";

/**
 * Mirrors apps/web: the shared packages ship as TypeScript SOURCE, so Next must
 * transpile them. Env follows the same rule — the monorepo-root .env is the single
 * source of truth, and scripts/sync-env.mjs generates .env.local with ONLY the
 * NEXT_PUBLIC_* vars before each run (Turbopack discovers .env.local natively).
 */
const nextConfig: NextConfig = {
  transpilePackages: ["@roam/design", "@roam/api", "@roam/db"],
  reactStrictMode: true,
};

export default nextConfig;
