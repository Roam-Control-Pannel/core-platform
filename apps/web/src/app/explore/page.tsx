/**
 * /explore — the place-anchored discovery surface (formerly the landing page; Home is the
 * landing now). Browsing needs no account (the "browse freely, auth on action" contract);
 * sign-in is reachable from the header. force-dynamic: per-request data + runtime env.
 */
export const dynamic = "force-dynamic";

import { Explore } from "../../components/Explore";

export default function ExplorePage() {
  return <Explore />;
}
