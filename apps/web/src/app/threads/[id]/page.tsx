/**
 * Thread detail route — /threads/[id]. Mirrors venue/[id]: force-dynamic, the
 * route param arrives as a Promise (Next 16) and is awaited, and TrpcProvider
 * supplies the session-bound client to the detail component beneath it.
 */
export const dynamic = "force-dynamic";

import { TrpcProvider } from "../../../components/TrpcProvider";
import { ThreadDetail } from "../../../components/ThreadDetail";

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <TrpcProvider>
      <ThreadDetail threadId={id} />
    </TrpcProvider>
  );
}
