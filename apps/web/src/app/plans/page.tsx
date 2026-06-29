/**
 * /plans — your plans (personal venue itineraries). force-dynamic: live per-request data +
 * runtime env; private to the signed-in user (the component shows the just-in-time sign-in).
 */
export const dynamic = "force-dynamic";

import { PlansList } from "../../components/PlansList";

export default function PlansPage() {
  return <PlansList />;
}
