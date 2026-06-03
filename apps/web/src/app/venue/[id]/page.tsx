/**
 * Venue detail route — /venue/[id].
 *
 * Mirrors the home route's contract: force-dynamic (live per-request data + runtime
 * env), and the TrpcProvider supplies the typed, session-bound client to the client
 * component beneath it. The param is the venue UUID; VenueDetail issues venues.byId.
 *
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import { TrpcProvider } from "../../../components/TrpcProvider";
import { VenueDetail } from "../../../components/VenueDetail";

export default async function VenuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <TrpcProvider>
      <VenueDetail venueId={id} />
    </TrpcProvider>
  );
}
