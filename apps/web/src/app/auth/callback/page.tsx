/**
 * /auth/callback — landing page for an OAuth (SSO) redirect.
 *
 * force-dynamic: it resolves a runtime Supabase session from the URL, then forwards the user to
 * their intended destination. The work lives in the client component (AuthCallback).
 */
export const dynamic = "force-dynamic";

import { AuthCallback } from "../../../components/AuthCallback";

export default function AuthCallbackPage() {
  return <AuthCallback />;
}
