/**
 * Following route — /following. The caller's followed venues, newest first, each with
 * a per-venue push toggle and an unfollow control. Like /threads, force-dynamic (live
 * per-request data, runtime env, Supabase session); the session-bound TrpcProvider is
 * mounted once in the root layout.
 *
 * Following is private (your follows are yours), so like ThreadList this surface gates
 * on a session — Following shows the just-in-time auth prompt when signed out.
 */
export const dynamic = "force-dynamic";

import { Following } from "../../components/Following";

export default function FollowingPage() {
  return <Following />;
}
