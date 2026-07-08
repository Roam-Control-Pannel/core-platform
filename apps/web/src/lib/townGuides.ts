/**
 * Town guides — the editorial "Known for / A little history / Local tip" copy for every UK
 * town, extracted from the original roam-local.co.uk town index pages (the content those
 * pages ranked on). Shipped as a checked-in data file rather than a DB table: it's static
 * editorial content, versioned with the app, read server-side only (the Town Hall hub), and
 * needs no ops to seed. If guides ever need in-app editing, this accessor is the single seam
 * to swap for a table read.
 *
 * A town having a guide makes its hub page substantial (genuine, unique copy), so guides
 * count toward hub indexability alongside topics and venues (see lib/seo hubIndexable).
 */
import guides from "../data/town-guides.json";

export interface TownGuide {
  name: string;
  region: string;
  knownFor: string;
  history: string;
  localTip: string;
}

const GUIDES = guides as Record<string, TownGuide>;

/** The guide for a locality slug (e.g. "darlington"), or null when we have none. */
export function townGuide(locality: string): TownGuide | null {
  return GUIDES[locality.toLowerCase()] ?? null;
}

/** Every locality slug that has a guide — the sitemap's guide-backed hub list. */
export function townGuideSlugs(): string[] {
  return Object.keys(GUIDES);
}
