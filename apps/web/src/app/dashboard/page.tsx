/**
 * /dashboard — the business home: the venues you've claimed, each a link into its owner editor.
 *
 * force-dynamic: owner-scoped (myVenues) and session-dependent; not a static page.
 */
export const dynamic = "force-dynamic";

import { BusinessDashboard } from "../../components/BusinessDashboard";

export default function DashboardPage() {
  return <BusinessDashboard />;
}
