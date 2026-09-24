/**
 * /activate — the member activation page (F2G plan 2.4), replacing /f2g/claim as the place an
 * invite link lands. Session-bound, so force-dynamic; noindex because it is a one-per-member
 * landing page reached from an email, never from search.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { ActivatePanel } from "../../components/ActivatePanel";

export const metadata: Metadata = {
  title: "Activate your listing",
  robots: { index: false, follow: false },
};

export default function ActivatePage() {
  return <ActivatePanel />;
}
