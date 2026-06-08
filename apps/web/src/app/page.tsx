/**
 * Explore is the web app's home. The TrpcProvider supplies the typed client (wired to
 * the live Supabase session) to everything beneath it; Explore is its first consumer.
 *
 * force-dynamic: this screen fetches per-request from the API and depends on runtime
 * env (the API URL, the Supabase session). It is NOT a static page, so we opt out of
 * build-time prerendering — the honest rendering mode for a live-data surface.
 */
export const dynamic = "force-dynamic";

import { TrpcProvider } from "../components/TrpcProvider";
import { Explore } from "../components/Explore";
import { EnableNotifications } from "../components/EnableNotifications";

export default function Home() {
  return (
    <TrpcProvider>
      <EnableNotifications />
      <Explore />
    </TrpcProvider>
  );
}
