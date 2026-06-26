/**
 * Thread detail route — /threads/[id]. Mirrors venue/[id]: force-dynamic, the
 * route param arrives as a Promise (Next 16) and is awaited. The session-bound
 * TrpcProvider is mounted once in the root layout.
 */
export const dynamic = "force-dynamic";

import { ThreadDetail } from "../../../components/ThreadDetail";

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ThreadDetail threadId={id} />;
}
