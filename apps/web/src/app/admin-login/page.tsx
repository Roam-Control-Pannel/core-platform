/**
 * /admin-login — the partner organisation's named front door (see AdminLogin).
 *
 * Force-dynamic like every session-bound surface, and explicitly noindex/nofollow: this is a private
 * entrance for a handful of named people, and a sign-in page in a search index is an invitation to
 * credential stuffing rather than a convenience. robots.txt disallows it too — the meta tag covers
 * the crawlers that reach a URL from a link rather than from the file.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { AdminLogin } from "../../components/AdminLogin";

export const metadata: Metadata = {
  title: "Organisation sign-in",
  robots: { index: false, follow: false },
};

export default function AdminLoginPage() {
  return <AdminLogin />;
}
