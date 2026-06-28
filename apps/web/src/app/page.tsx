/**
 * The web app's landing page is the Home hub. The TrpcProvider (root layout) supplies the
 * typed client wired to the live Supabase session; Home is its first consumer.
 *
 * Home pulls together the day-to-day surfaces (recent chats, followed venues + their deals,
 * local news, your town, the town forum). Browsing needs no account — the auth-gated widgets
 * nudge sign-in rather than gating the page. Explore now lives at /explore.
 *
 * force-dynamic: live per-request data + runtime env (API URL, Supabase session); not static.
 */
export const dynamic = "force-dynamic";

import { Home } from "../components/Home";

export default function RootPage() {
  return <Home />;
}
