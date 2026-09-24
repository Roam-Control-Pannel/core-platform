/**
 * Association route — /association: the partner organisation's own portal (F2G plan 3.3).
 * Force-dynamic like every session-bound surface; AssociationPortal gates on the session and then
 * on the caller's appointment in channel_admins.
 */
export const dynamic = "force-dynamic";

import { AssociationPortal } from "../../components/AssociationPortal";

export default function AssociationPage() {
  return <AssociationPortal />;
}
