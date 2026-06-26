/**
 * Explore is the web app's home. The TrpcProvider supplies the typed client (wired to
 * the live Supabase session) to everything beneath it; Explore is its first consumer.
 *
 * The home is Explore alone — browsing needs no account (the "browse freely, auth on
 * action" contract). Sign-in is reachable from the Explore header (a "Sign in" button
 * that opens the AuthModal) rather than a form gating the page. The notifications
 * capture lives on /following, the account-ish surface where you manage follows.
 *
 * force-dynamic: this screen fetches per-request from the API and depends on runtime
 * env (the API URL, the Supabase session). It is NOT a static page, so we opt out of
 * build-time prerendering — the honest rendering mode for a live-data surface.
 */
export const dynamic = "force-dynamic";

import { TrpcProvider } from "../components/TrpcProvider";
import { Explore } from "../components/Explore";

export default function Home() {
  return (
    <TrpcProvider>
      <Explore />
    </TrpcProvider>
  );
}
