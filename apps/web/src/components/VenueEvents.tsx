/**
 * VenueEvents — the "What's on here" block on a venue page. Client-fetched (the venue page's own
 * SEO is the LocalBusiness JSON-LD; this is a cross-link/navigation aid) via events.byVenue, and it
 * always offers a "Post an event here" affordance that deep-links to the composer with this venue
 * pre-attached (/events?new=1&venue=<id>&venueName=<name>) — the venue-tied path that also sharpens
 * "near me". Renders nothing until loaded, then the list or a short prompt.
 */
"use client";

import { useEffect, useState } from "react";
import { useTrpc } from "./TrpcProvider";
import { UpcomingEvents } from "./UpcomingEvents";
import type { HubEvent } from "../lib/serverApi";

export function VenueEvents({ venueId, venueName }: { venueId: string; venueName: string }) {
  const trpc = useTrpc();
  const [events, setEvents] = useState<HubEvent[] | null>(null);

  useEffect(() => {
    let live = true;
    const q = trpc.events.byVenue as unknown as { query: (i: { venueId: string; limit: number }) => Promise<{ events: HubEvent[] }> };
    q.query({ venueId, limit: 6 }).then((r) => { if (live) setEvents(r.events); }).catch(() => { if (live) setEvents([]); });
    return () => { live = false; };
  }, [trpc, venueId]);

  if (events === null) return null; // don't flash an empty state before the fetch resolves

  const postHref = `/events?new=1&venue=${encodeURIComponent(venueId)}&venueName=${encodeURIComponent(venueName)}`;
  return (
    <div style={{ marginTop: "var(--space-6)" }}>
      <UpcomingEvents
        title="What's on here"
        events={events}
        postHref={postHref}
        postLabel="Post an event here"
        emptyBody={`No upcoming events at ${venueName} yet — post one so locals know what's on.`}
      />
    </div>
  );
}
