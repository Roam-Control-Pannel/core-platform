/**
 * /events/{id} — the public, indexable page for one event (server-rendered). Carries the
 * schema.org Event JSON-LD + per-event metadata (date, place, organizer) so events surface as
 * rich results and share with a proper card. Cancelled events flip to noindex (see eventMetadata)
 * while the link still resolves. The interactive bits (interested/report) hydrate client-side.
 *
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EventScreen } from "../../../components/EventScreen";
import { JsonLd } from "../../../components/JsonLd";
import { getEvent } from "../../../lib/serverApi";
import { eventMetadata, eventJsonLd } from "../../../lib/seo";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return eventMetadata(await getEvent(id), id);
}

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) notFound();

  return (
    <>
      {event.status === "published" ? <JsonLd data={eventJsonLd(event)} /> : null}
      <EventScreen initial={event} />
    </>
  );
}
