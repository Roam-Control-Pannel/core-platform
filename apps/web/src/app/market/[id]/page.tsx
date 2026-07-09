/**
 * Listing detail route — /market/[id]: one C2C marketplace listing, now a real SEO surface.
 * The server component resolves the listing once (anonymous, per-request cached) to build
 * metadata + Product/Offer JSON-LD and to seed ListingDetail's first paint, so the full
 * listing content is in the initial HTML for crawlers ("second hand sofa darlington").
 * LIVE listings are indexable; sold/removed flip to noindex (see listingMetadata) so search
 * drops stale ads while old links still resolve. Next 16: the param arrives as a Promise.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { ListingDetail } from "../../../components/ListingDetail";
import { JsonLd } from "../../../components/JsonLd";
import { getListing } from "../../../lib/serverApi";
import { listingMetadata, listingJsonLd } from "../../../lib/seo";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const listing = UUID_RE.test(id) ? await getListing(id) : null;
  return listingMetadata(listing, id);
}

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const listing = UUID_RE.test(id) ? await getListing(id) : null;
  return (
    <>
      {listing && listing.status === "live" ? <JsonLd data={listingJsonLd(listing)} /> : null}
      <ListingDetail listingId={id} initial={listing} />
    </>
  );
}
