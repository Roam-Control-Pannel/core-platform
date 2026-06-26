/**
 * Threads route — /threads. The chat surface's home: the caller's thread list +
 * create. Like the home route, force-dynamic (live per-request data, runtime env,
 * Supabase session); the session-bound TrpcProvider is mounted once in the root layout.
 *
 * Chat is private, so unlike Explore this surface gates on a session — ThreadList
 * shows the just-in-time auth prompt when signed out (the claim-flow pattern).
 */
export const dynamic = "force-dynamic";

import { ThreadList } from "../../components/ThreadList";

export default function ThreadsPage() {
  return <ThreadList />;
}
