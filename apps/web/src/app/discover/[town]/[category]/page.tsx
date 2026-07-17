/**
 * Discovery intent page — /discover/{town}/{category} (e.g. /discover/darlington/food-and-drink):
 * "Best places to eat & drink in Darlington". A focused, indexable landing page built for the
 * local-intent queries people actually search, filtering the town's venues to a single category
 * and ranking them best-first (server-rendered).
 *
 * `town` is a locality slug; `category` is one of the curated discovery slugs (lib/discover). An
 * unknown category slug 404s. Real search intent only — below DISCOVER_MIN_VENUES the page still
 * renders for humans but sets noindex (see discoverMetadata), so Roam never ships a doorway page.
 *
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DiscoverScreen } from "../../../../components/DiscoverScreen";
import { JsonLd } from "../../../../components/JsonLd";
import { getDiscoverVenues } from "../../../../lib/serverApi";
import { discoverCategoryBySlug } from "../../../../lib/discover";
import { discoverMetadata, discoverJsonLd, discoverIndexable } from "../../../../lib/seo";
import { townGuide } from "../../../../lib/townGuides";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ town: string; category: string }>;
}): Promise<Metadata> {
  const { town, category } = await params;
  const cat = discoverCategoryBySlug(category);
  if (!cat) return { title: "Discover", robots: { index: false, follow: true } };
  const guide = townGuide(town);
  const label = guide?.name ?? town;
  const venues = await getDiscoverVenues(label, cat.category);
  return discoverMetadata(cat, label, town, venues.length, guide?.region ?? null);
}

export default async function DiscoverPage({
  params,
}: {
  params: Promise<{ town: string; category: string }>;
}) {
  const { town, category } = await params;
  const cat = discoverCategoryBySlug(category);
  if (!cat) notFound();

  const guide = townGuide(town);
  // The guide's name is the canonical display label (proper casing, e.g. "Bury St Edmunds").
  const label = guide?.name ?? town;
  const region = guide?.region ?? null;
  const venues = await getDiscoverVenues(label, cat.category);

  return (
    <>
      {discoverIndexable(venues.length) ? (
        <JsonLd data={discoverJsonLd(cat, label, town, venues, region)} />
      ) : null}
      <DiscoverScreen cat={cat} localityLabel={label} locality={town} region={region} venues={venues} />
    </>
  );
}
