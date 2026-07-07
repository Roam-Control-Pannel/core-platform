/**
 * Thread detail route — /threads/[id], rendered through the two-pane ChatShell: the Chats
 * list stays docked left on desktop (this thread tinted active), the conversation fills the
 * right pane; mobile shows the conversation alone with a back link. Mirrors venue/[id]:
 * force-dynamic, the route param arrives as a Promise (Next 16) and is awaited.
 */
export const dynamic = "force-dynamic";

import { ChatShell } from "../../../components/ChatShell";
import { ThreadDetail } from "../../../components/ThreadDetail";

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ChatShell mode="detail" activeThreadId={id}>
      <ThreadDetail threadId={id} />
    </ChatShell>
  );
}
