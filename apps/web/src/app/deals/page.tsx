/**
 * /deals — the Awin affiliate deals page. Public (browse-freely); reads live deals via the
 * session-bound TrpcProvider from the root layout. force-dynamic since the list is live data.
 */
import type { Metadata } from "next";
import { Deals } from "../../components/Deals";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Deals",
  description: "Handpicked offers and voucher codes from brands Roam partners with.",
};

export default function DealsPage() {
  return <Deals />;
}
