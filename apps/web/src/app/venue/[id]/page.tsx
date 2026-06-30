/**
 * Venue detail route — /venue/[id].
 *
 * The segment is now the venue's slug (the canonical, human-readable URL, e.g.
 * /venue/the-bridge-hotel-durham); a legacy UUID is still accepted and 301-redirected to the
 * slug, so old links keep working and search consolidates on one canonical address.
 *
 * force-dynamic (live per-request data + runtime env). The session-bound TrpcProvider is mounted
 * once in the root layout. This server component resolves the venue once (anonymous, cached) to
 * build per-page metadata, a LocalBusiness JSON-LD block, and the SSR body seed; VenueDetail
 * hydrates for the interactive view (photos, follow, claim).
 *
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";
import { VenueDetail, type VenueDetailData } from "../../../components/VenueDetail";
import { JsonLd } from "../../../components/JsonLd";
import { getVenue, getVenueBySlug } from "../../../lib/serverApi";
import { venueMetadata, venueJsonLd, type VenueSeo } from "../../../lib/seo";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve the route param (slug or legacy UUID) to a venue. */
async function resolve(idOrSlug: string): Promise<VenueSeo | null> {
  return UUID_RE.test(idOrSlug) ? getVenue(idOrSlug) : getVenueBySlug(idOrSlug);
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return venueMetadata(await resolve(id), id);
}

export default async function VenuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Legacy UUID link → 301 to the canonical /venue/{slug} when the venue has one.
  if (UUID_RE.test(id)) {
    const v = await getVenue(id);
    if (v?.slug) permanentRedirect(`/venue/${v.slug}`);
    const seed = (v as unknown as VenueDetailData | null) ?? null;
    return (
      <>
        {v ? <JsonLd data={venueJsonLd(v, id)} /> : null}
        <VenueDetail venueId={id} initialVenue={seed} />
      </>
    );
  }

  const venue = await getVenueBySlug(id);
  // VenueDetail fetches by venue id; hand it the resolved UUID (or the raw param when unknown, so
  // it renders its own not-found state).
  const venueId = venue?.id ?? id;
  const seed = (venue as unknown as VenueDetailData | null) ?? null;
  return (
    <>
      {venue ? <JsonLd data={venueJsonLd(venue, id)} /> : null}
      <VenueDetail venueId={venueId} initialVenue={seed} />
    </>
  );
}
