/**
 * /town-hall — the interactive forum board, scoped to the place you're browsing (PlaceSwitcher).
 * This is the live app surface for browsing + posting; the canonical, indexable per-town pages are
 * the hubs at /town-hall/{town}. Because this one URL shows different towns by state, it can't be
 * canonical per town, so it's set noindex — crawlers index the hubs instead (no duplicate content).
 *
 * force-dynamic: the active place and topic list are live per-request data via the session-bound
 * TrpcProvider mounted once in the root layout. Public to read; posting/upvoting auths just-in-time.
 */
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Town Hall",
  robots: { index: false, follow: true },
};

import { TownHall } from "../../components/TownHall";

export default function TownHallPage() {
  return <TownHall />;
}
