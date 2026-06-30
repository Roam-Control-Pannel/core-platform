/**
 * Town Hall topic — /town-hall/{town}/{topic-slug}: a single discussion thread at its canonical
 * URL. force-dynamic; the session-bound TrpcProvider comes from the root layout.
 *
 * SEO: resolves the topic by (locality, slug) once (anonymous, cached) for per-page metadata and a
 * DiscussionForumPosting JSON-LD block (with reply comments) in the initial HTML, and seeds the
 * full thread into the SSR body. TownHallTopic hydrates for upvote/reply.
 *
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { TownHallTopic, type TopicDetailData } from "../../../../components/TownHallTopic";
import { JsonLd } from "../../../../components/JsonLd";
import { getTopicBySlug } from "../../../../lib/serverApi";
import { topicMetadata, topicJsonLd } from "../../../../lib/seo";

export async function generateMetadata({ params }: { params: Promise<{ town: string; topic: string }> }): Promise<Metadata> {
  const { town, topic } = await params;
  return topicMetadata(await getTopicBySlug(town, topic), topic);
}

export default async function TownHallTopicPage({ params }: { params: Promise<{ town: string; topic: string }> }) {
  const { town, topic } = await params;
  const data = await getTopicBySlug(town, topic);
  const initialData = (data as unknown as TopicDetailData | null) ?? null;
  // TownHallTopic refreshes by topic id; hand it the resolved UUID (empty string when not found,
  // so its seeded not-found state shows).
  const topicId = data?.topic.id ?? "";
  return (
    <>
      {data ? <JsonLd data={topicJsonLd(data, topic)} /> : null}
      <TownHallTopic topicId={topicId} initialData={initialData} />
    </>
  );
}
