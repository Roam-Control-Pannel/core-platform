/**
 * Town Hall topic route — /town-hall/[topicId].
 *
 * Mirrors the venue route: force-dynamic (live per-request data + runtime env), the
 * session-bound TrpcProvider from the root layout. The param is the topic UUID; the
 * detail component issues townHall.getTopic for the interactive view.
 *
 * SEO: this server component resolves the topic + replies once (anonymous, cached) for per-page
 * metadata and a DiscussionForumPosting JSON-LD block (with reply comments) in the initial HTML —
 * the structured data Google renders for forum threads. The thread hydrates client-side.
 *
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { TownHallTopic } from "../../../components/TownHallTopic";
import { JsonLd } from "../../../components/JsonLd";
import { getTopic } from "../../../lib/serverApi";
import { topicMetadata, topicJsonLd } from "../../../lib/seo";

export async function generateMetadata({ params }: { params: Promise<{ topicId: string }> }): Promise<Metadata> {
  const { topicId } = await params;
  return topicMetadata(await getTopic(topicId), topicId);
}

export default async function TownHallTopicPage({ params }: { params: Promise<{ topicId: string }> }) {
  const { topicId } = await params;
  const data = await getTopic(topicId);
  return (
    <>
      {data ? <JsonLd data={topicJsonLd(data, topicId)} /> : null}
      <TownHallTopic topicId={topicId} />
    </>
  );
}
