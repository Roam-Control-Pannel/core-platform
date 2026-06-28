/**
 * /home — the hub: recent chats, your town, the town forum, plus the upcoming-plans and
 * market seams. Like Explore, force-dynamic: live per-request data (chats, venues, topics)
 * read through the session-bound TrpcProvider mounted once in the root layout. Public to
 * view; the auth-gated section nudges sign-in rather than gating the page.
 */
export const dynamic = "force-dynamic";

import { Home } from "../../components/Home";

export default function HomePage() {
  return <Home />;
}
