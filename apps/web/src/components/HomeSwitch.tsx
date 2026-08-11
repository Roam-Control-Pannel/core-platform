/**
 * HomeSwitch — routes the landing page to the right home for the active brand channel.
 *
 * On the Food to Go channel it renders the storefront home; otherwise the Roam home. Branching
 * lives in this thin client wrapper (not inside Home) so the heavy Roam Home only mounts when it's
 * actually the Roam channel — and so we never break Home's hook order. The channel key comes from
 * the cookie almost immediately (see ChannelProvider), so the default Roam path renders without
 * waiting on a round-trip; the f2g path swaps in on the first post-mount tick.
 */
"use client";

import { useChannel } from "./ChannelProvider";
import { Home } from "./Home";
import { StorefrontHome } from "./StorefrontHome";

export function HomeSwitch() {
  const { isF2G } = useChannel();
  return isF2G ? <StorefrontHome /> : <Home />;
}
