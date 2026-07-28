/**
 * Deal click-through — network-aware. The Deals surface unions two affiliate networks and each
 * tracks differently:
 *
 *   - Awin: the destination is a plain landing URL; we wrap it with the PUBLIC publisher id at
 *     render (see buildAwinLink) so the id lives in one place.
 *   - CJ (Commission Junction): the destination IS CJ's clickUrl — already affiliate-tracked (the
 *     website id is baked in by CJ) — so we use it verbatim and never wrap it.
 *
 * One helper so every deal CTA dispatches on `network` without each call site knowing the rules.
 */
import { buildAwinLink } from "./awin";

export function buildDealLink(opts: {
  network?: string | null | undefined;
  advertiserId: string;
  destinationUrl: string;
  clickRef?: string | undefined;
}): string {
  if ((opts.network ?? "awin") === "cj") return opts.destinationUrl; // already tracked by CJ
  return buildAwinLink({
    advertiserId: opts.advertiserId,
    destinationUrl: opts.destinationUrl,
    ...(opts.clickRef ? { clickRef: opts.clickRef } : {}),
  });
}
