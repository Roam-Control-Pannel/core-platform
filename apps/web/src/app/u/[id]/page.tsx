/**
 * Profile wall route — /u/[id]. A user's public wall: their posts, likes and comments. The
 * param is the profile (user) UUID; the component issues profiles.byId + profileWall.list.
 *
 * Public to view (browse-freely); posting is owner-only, liking/commenting need a session —
 * all prompted just-in-time, so the page does not gate. force-dynamic: live per-request data.
 *
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import { ProfileWall } from "../../../components/ProfileWall";

export default async function ProfileWallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProfileWall userId={id} />;
}
