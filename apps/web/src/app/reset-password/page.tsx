/**
 * /reset-password — landing page for the password-reset email link.
 *
 * force-dynamic: the page resolves a runtime Supabase recovery session from the URL; it is
 * not static. The work lives in the client component (ResetPassword).
 */
export const dynamic = "force-dynamic";

import { ResetPassword } from "../../components/ResetPassword";

export default function ResetPasswordPage() {
  return <ResetPassword />;
}
