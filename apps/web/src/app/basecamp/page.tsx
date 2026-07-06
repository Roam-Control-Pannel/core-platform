/**
 * /basecamp — the dedicated widget page: every Home widget at full size, quick navigation to
 * every surface, and the Customise (drag-reorder + hide) experience. Shares its saved layout
 * with Home's rail. force-dynamic: live per-request data + runtime env.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { Basecamp } from "../../components/Basecamp";

export const metadata: Metadata = {
  title: "Basecamp",
  description: "Your Roam, your way — every widget, full size, and one-tap navigation to everything local.",
};

export default function BasecampPage() {
  return <Basecamp />;
}
