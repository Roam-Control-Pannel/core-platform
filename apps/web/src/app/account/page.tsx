/**
 * /account — the signed-in user's hub: edit your profile, jump to your dashboard / follows.
 *
 * force-dynamic: depends on the runtime Supabase session (and reads profiles.me per request);
 * it is not a static page.
 */
export const dynamic = "force-dynamic";

import { AccountHub } from "../../components/AccountHub";

export default function AccountPage() {
  return <AccountHub />;
}
