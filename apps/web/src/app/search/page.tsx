/**
 * /search — the full site-wide search results page (People · Places · Events · Community ·
 * Marketplace), reached from the TopBar search bar's "See all" / Enter. Interactive + noindex
 * (results pages aren't index-worthy); the indexable surfaces are the entities themselves.
 *
 * SearchResults reads ?q via useSearchParams, so it's wrapped in Suspense per Next's requirement.
 */
import type { Metadata } from "next";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Search",
  robots: { index: false, follow: true },
};

import { SearchResults } from "../../components/SearchResults";

export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <SearchResults />
    </Suspense>
  );
}
