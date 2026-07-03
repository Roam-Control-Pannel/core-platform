/**
 * Deal permalink route — /deals/[dealId]. The shareable home of one affiliate deal: the deep-link
 * target the deal cards' "Share" produces, with OG tags so it unfurls as a card on WhatsApp /
 * LinkedIn / Facebook. An external recipient lands here (title, description, code, disclosure)
 * rather than straight on the advertiser. noindex — deals churn on the affiliate feed's schedule.
 *
 * force-dynamic: live per-request data + runtime env. Next 15+/16 passes route params as a
 * Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { DealDetail, type Deal } from "../../../components/Deals";
import { getDeal } from "../../../lib/serverApi";
import { dealMetadata } from "../../../lib/seo";

export async function generateMetadata({ params }: { params: Promise<{ dealId: string }> }): Promise<Metadata> {
  const { dealId } = await params;
  return dealMetadata(await getDeal(dealId), dealId);
}

export default async function DealPage({ params }: { params: Promise<{ dealId: string }> }) {
  const { dealId } = await params;
  const deal = await getDeal(dealId);
  // Seed the client screen so the deal is in the initial HTML. The runtime shape matches Deal
  // (deals.byId); the seo type is a subset, so we narrow with a cast.
  const initialDeal = (deal as unknown as Deal | null) ?? null;
  return <DealDetail dealId={dealId} initialDeal={initialDeal} />;
}
