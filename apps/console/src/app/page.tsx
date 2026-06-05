/**
 * Console home — the Overview. Mirrors apps/web's page contract: force-dynamic
 * (live per-request data + runtime env + Supabase session), TrpcProvider supplies
 * the session-bound typed client to the surface beneath it.
 *
 * The console is PRIVATE (a business surface), so Overview gates on useSession():
 * signed out shows a sign-in prompt rather than the consumer app's public browse.
 */
export const dynamic = "force-dynamic";

import { TrpcProvider } from "../components/TrpcProvider";
import { Overview } from "../components/Overview";

export default function ConsoleHome() {
  return (
    <TrpcProvider>
      <Overview />
    </TrpcProvider>
  );
}
