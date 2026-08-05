/**
 * Roam HQ home. Mirrors the web/console page contract: force-dynamic (live per-request
 * data + runtime env + Supabase session), TrpcProvider supplies the session-bound typed
 * client to the dashboard beneath it.
 *
 * Roam HQ is staff-only: HQ gates on the session AND on the API's adminProcedure (via
 * adminMetrics.me), so a signed-out or non-staff visitor never sees platform data.
 */
export const dynamic = "force-dynamic";

import { TrpcProvider } from "../components/TrpcProvider";
import { HQ } from "../components/HQ";

export default function AdminHome() {
  return (
    <TrpcProvider>
      <HQ />
    </TrpcProvider>
  );
}
