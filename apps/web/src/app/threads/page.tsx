/**
 * Threads route — /threads. The chat surface's home, rendered through the two-pane ChatShell:
 * the Chats list (with create) docked left; on desktop the right pane invites picking a
 * conversation. Like the home route, force-dynamic (live per-request data, runtime env,
 * Supabase session); the session-bound TrpcProvider is mounted once in the root layout.
 *
 * Chat is private, so unlike Explore this surface gates on a session — ThreadList
 * shows the just-in-time auth prompt when signed out (the claim-flow pattern).
 */
export const dynamic = "force-dynamic";

import { ChatShell, EmptyThreadPane } from "../../components/ChatShell";

export default function ThreadsPage() {
  return (
    <ChatShell mode="list">
      <EmptyThreadPane />
    </ChatShell>
  );
}
