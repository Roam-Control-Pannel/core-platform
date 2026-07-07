/** Market route — /market: the C2C buy/sell/swap marketplace. Force-dynamic (live data). */
export const dynamic = "force-dynamic";

import { Market } from "../../components/Market";

export default function MarketPage() {
  return <Market />;
}
