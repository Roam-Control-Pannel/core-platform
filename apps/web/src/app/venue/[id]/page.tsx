/**
 * Venue detail route — /venue/[id].
 *
 * Mirrors the home route's contract: force-dynamic (live per-request data + runtime
 * env). The typed, session-bound TrpcProvider is mounted once in the root layout. The
 * param is the venue UUID; VenueDetail issues venues.byId for the interactive view.
 *
 * For SEO this server component also resolves the venue once (anonymous, cached) to build
 * per-page metadata (title/description/Open Graph) and a LocalBusiness JSON-LD block in the
 * initial HTML — what crawlers and link unfurlers read. The body still hydrates client-side.
 *
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { VenueDetail, type VenueDetailData } from "../../../components/VenueDetail";
import { JsonLd } from "../../../components/JsonLd";
import { getVenue } from "../../../lib/serverApi";
import { venueMetadata, venueJsonLd } from "../../../lib/seo";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return venueMetadata(await getVenue(id), id);
}

export default async function VenuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const venue = await getVenue(id);
  // Seed the client with the venue so its name, description, category and locality are in the
  // initial HTML. venues.byId returns the full row at runtime; the seo type is a narrow subset,
  // so we cast to the component's view shape (photos + follow state still hydrate client-side).
  const initialVenue = (venue as unknown as VenueDetailData | null) ?? null;
  return (
    <>
      {venue ? <JsonLd data={venueJsonLd(venue, id)} /> : null}
      <VenueDetail venueId={id} initialVenue={initialVenue} />
    </>
  );
}
