/**
 * /plans/[planId] — a single plan's detail. force-dynamic: live per-request data + runtime env.
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import { PlanDetail } from "../../../components/PlanDetail";

export default async function PlanDetailPage({ params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  return <PlanDetail planId={planId} />;
}
