/**
 * /town-hall — the per-locality public forum board. Like Explore, force-dynamic: the active
 * place and the topic list are live per-request data read through the session-bound
 * TrpcProvider mounted once in the root layout. Public to read; posting/upvoting auths
 * just-in-time, so this surface does not itself gate on a session.
 */
export const dynamic = "force-dynamic";

import { TownHall } from "../../components/TownHall";

export default function TownHallPage() {
  return <TownHall />;
}
