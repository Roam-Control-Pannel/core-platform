/**
 * /friends — your friends + incoming requests. force-dynamic: live per-request data + runtime
 * env; private to the signed-in user (the component shows the just-in-time sign-in).
 */
export const dynamic = "force-dynamic";

import { FriendsList } from "../../components/FriendsList";

export default function FriendsPage() {
  return <FriendsList />;
}
