/**
 * Orders route — /orders: the buyer's purchase history (and Stripe checkout's landing page).
 * Force-dynamic like every session-bound surface; MyOrders gates on the session itself.
 */
export const dynamic = "force-dynamic";

import { MyOrders } from "../../components/MyOrders";

export default function OrdersPage() {
  return <MyOrders />;
}
