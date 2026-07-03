/**
 * /plans/[planId] — a single plan's detail. force-dynamic: live per-request data + runtime env.
 *
 * A shared plan link now unfurls: generateMetadata reads plans.preview (the public TEASER — title,
 * date, header image, counts only; never notes, venues, or members) so the OG card renders for
 * link recipients, while robots stays noindex/nofollow (plans are private-by-membership). The
 * same preview seeds PlanDetail's non-member view.
 *
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { PlanDetail } from "../../../components/PlanDetail";
import { getPlanPreview } from "../../../lib/serverApi";
import { planMetadata } from "../../../lib/seo";

export async function generateMetadata({ params }: { params: Promise<{ planId: string }> }): Promise<Metadata> {
  const { planId } = await params;
  return planMetadata(await getPlanPreview(planId), planId);
}

export default async function PlanDetailPage({ params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  const preview = await getPlanPreview(planId);
  return <PlanDetail planId={planId} preview={preview} />;
}
