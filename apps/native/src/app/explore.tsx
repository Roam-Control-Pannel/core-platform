/**
 * /explore — the place-anchored discovery surface, mirroring web's /explore route.
 *
 * A thin route file: the screen lives in components/explore so its composition reads in one
 * place and the router layer stays free of product logic.
 */
import { ExploreScreen } from "../components/explore/ExploreScreen";

export default function ExploreRoute() {
  return <ExploreScreen />;
}
