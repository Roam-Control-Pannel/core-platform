/**
 * /jobs — the F2G employability board (C4-b). A live, channel-scoped list (the active channel comes
 * from the session-bound providers in the root layout), so it's noindex: it renders different content
 * per channel and per state. Public to read; posting auths just-in-time and is gated on live membership.
 */
import type { Metadata } from "next";
import { Jobs } from "../../components/Jobs";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Local jobs",
  robots: { index: false, follow: true },
};

export default function JobsPage() {
  return <Jobs />;
}
