/**
 * /business — the public "business door": explains claiming and routes into the existing
 * claim/verify journey. Reachable signed-out (the offer is public); the claim itself uses
 * the same account + flow as everything else.
 *
 * force-dynamic: reads the runtime session to tailor the CTAs.
 */
export const dynamic = "force-dynamic";

import { BusinessLanding } from "../../components/BusinessLanding";

export default function BusinessPage() {
  return <BusinessLanding />;
}
