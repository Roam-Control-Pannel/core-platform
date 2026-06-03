import type { NextConfig } from "next";

/**
 * The shared packages (@roam/design, @roam/api types, @roam/db) ship as TypeScript
 * SOURCE, not built JS (that's the workspace's source-resolution convention). Next must
 * transpile them rather than expecting pre-built dist output — transpilePackages does that.
 */
const nextConfig: NextConfig = {
  transpilePackages: ["@roam/design", "@roam/api", "@roam/db"],
  reactStrictMode: true,
};

export default nextConfig;
