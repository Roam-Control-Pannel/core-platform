/**
 * Town Hall topic route — /town-hall/[topicId].
 *
 * Mirrors the venue route: force-dynamic (live per-request data + runtime env), the
 * session-bound TrpcProvider from the root layout. The param is the topic UUID; the
 * detail component issues townHall.getTopic.
 *
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import { TownHallTopic } from "../../../components/TownHallTopic";

export default async function TownHallTopicPage({ params }: { params: Promise<{ topicId: string }> }) {
  const { topicId } = await params;
  return <TownHallTopic topicId={topicId} />;
}
