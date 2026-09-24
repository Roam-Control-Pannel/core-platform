/**
 * Association route — /association: the partner organisation's own portal (F2G plan 3.3).
 * Force-dynamic like every session-bound surface; AssociationPortal gates on the session and then
 * on the caller's appointment in channel_admins.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { AssociationPortal } from "../../components/AssociationPortal";

// Private to a partner's officers: never index it, and never follow out of it.
export const metadata: Metadata = {
  title: "Organisation portal",
  robots: { index: false, follow: false },
};

export default function AssociationPage() {
  return <AssociationPortal />;
}
