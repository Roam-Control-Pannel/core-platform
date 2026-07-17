/**
 * /events — the interactive "what's on" board, scoped to the place you're browsing (PlaceSwitcher).
 * This one URL shows different towns by state, so it can't be canonical per town — it's set
 * noindex; crawlers index each event's own /events/{id} page (and, in PR 3, the town hubs).
 *
 * force-dynamic: the active place and event list are live per-request via the session-bound
 * TrpcProvider mounted in the root layout. Public to read; posting/interest auths just-in-time.
 */
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "What's on",
  robots: { index: false, follow: true },
};

import { Events } from "../../components/Events";

export default function EventsPage() {
  return <Events />;
}
