/**
 * /notifications — the notification center. force-dynamic: live per-request data + runtime env;
 * private to the signed-in user (the component shows the just-in-time sign-in when signed out).
 */
export const dynamic = "force-dynamic";

import { NotificationCenter } from "../../components/NotificationCenter";

export default function NotificationsPage() {
  return <NotificationCenter />;
}
