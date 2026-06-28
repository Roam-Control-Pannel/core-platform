/**
 * /dashboard/[venueId] — the owner editor for one claimed venue (photos, details, hours).
 *
 * force-dynamic + async params, same contract as /venue/[id]. The editor reuses the existing
 * owner editors; every write is RLS-gated to the venue's owner.
 */
export const dynamic = "force-dynamic";

import { VenueOwnerEditor } from "../../../components/VenueOwnerEditor";

export default async function DashboardVenuePage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = await params;
  return <VenueOwnerEditor venueId={venueId} />;
}
