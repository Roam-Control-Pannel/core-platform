/**
 * Town Hall hub — /town-hall/{town} (e.g. /town-hall/durham): the canonical, indexable page for a
 * locality, aggregating its discussion, featured venues and local news (server-rendered).
 *
 * The segment is normally a locality slug. A legacy /town-hall/{uuid} (old topic link) is detected
 * and 301-redirected to the canonical /town-hall/{town}/{topic-slug}.
 *
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";
import { TownHallHub } from "../../../components/TownHallHub";
import { JsonLd } from "../../../components/JsonLd";
import { getHub, getHubVenues, getHubNews, getTopic } from "../../../lib/serverApi";
import { hubMetadata, hubJsonLd } from "../../../lib/seo";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: Promise<{ town: string }> }): Promise<Metadata> {
  const { town } = await params;
  if (UUID_RE.test(town)) return { title: "Town Hall" };
  const hub = await getHub(town);
  const label = hub?.localityLabel ?? town;
  return hubMetadata(label, town, !!hub?.hasTopics);
}

export default async function TownHubPage({ params }: { params: Promise<{ town: string }> }) {
  const { town } = await params;

  // Legacy /town-hall/{uuid} topic link → 301 to the canonical nested URL.
  if (UUID_RE.test(town)) {
    const data = await getTopic(town);
    if (data?.topic?.slug) permanentRedirect(`/town-hall/${data.topic.locality}/${data.topic.slug}`);
    // Unknown UUID — fall through to an (empty) hub render, which is noindexed.
  }

  const hub = (await getHub(town)) ?? { locality: town, localityLabel: town, hasTopics: false, topics: [] };
  const [venues, news] = await Promise.all([getHubVenues(hub.localityLabel), getHubNews(hub.localityLabel)]);

  return (
    <>
      {hub.hasTopics ? <JsonLd data={hubJsonLd(hub.localityLabel, hub.locality || town)} /> : null}
      <TownHallHub hub={hub} venues={venues} news={news} />
    </>
  );
}
