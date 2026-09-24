/**
 * @roam/core/association — the partner organisation's own view of its channel (F2G plan 3.2).
 *
 * Thin, typed wrappers over the 0157 RPCs. The aggregation lives in SQL, not here, for one reason
 * that matters: those functions are SECURITY DEFINER and re-check `is_channel_admin` themselves, so
 * the containment holds even for a caller who reaches the RPC directly through PostgREST rather than
 * through the API's gate. Re-implementing the maths in TypeScript would move the authority check to
 * a place a direct caller can walk past.
 *
 * Every function here therefore does the same small job: call, check for an error, map snake_case to
 * the shape the portal renders. A caller with no appointment gets NO ROWS from the RPC, which
 * surfaces as `null` (overview, totals) or an empty list — never a zeroed row that would read as a
 * genuinely quiet week.
 */
import type { RoamClient } from "@roam/db";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rpc = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};
const rpc = (client: RoamClient): Rpc => client as unknown as Rpc;

/** The overview screen's tiles, in one snapshot. */
export interface ChannelPortalOverview {
  membersTotal: number;
  funnel: { imported: number; invited: number; claimed: number; live: number; lapsed: number; removed: number };
  /** Non-members that opted a venue into the storefront: listed, never ranked or badged as members. */
  listedNonMembers: number;
  memberVenues: number;
  /** Of `memberVenues`, how many carry a displayable FSA rating ('0'..'5'). */
  memberVenuesRated: number;
  jobsOpen: number;
  jobsTotal: number;
  suppliersApproved: number;
  suppliersPending: number;
}

/** Null when the caller holds no appointment for this channel — the RPC returned no rows. */
export async function getPortalOverview(
  client: RoamClient,
  channelId: string,
): Promise<ChannelPortalOverview | null> {
  const { data, error } = await rpc(client).rpc("channel_portal_overview", { p_channel_id: channelId });
  if (error) throw new Error(`association: overview failed: ${error.message}`);
  const row = (data as any[])?.[0];
  if (!row) return null;
  return {
    membersTotal: Number(row.members_total ?? 0),
    funnel: {
      imported: Number(row.members_imported ?? 0),
      invited: Number(row.members_invited ?? 0),
      claimed: Number(row.members_claimed ?? 0),
      live: Number(row.members_live ?? 0),
      lapsed: Number(row.members_lapsed ?? 0),
      removed: Number(row.members_removed ?? 0),
    },
    listedNonMembers: Number(row.listed_non_members ?? 0),
    memberVenues: Number(row.member_venues ?? 0),
    memberVenuesRated: Number(row.member_venues_rated ?? 0),
    jobsOpen: Number(row.jobs_open ?? 0),
    jobsTotal: Number(row.jobs_total ?? 0),
    suppliersApproved: Number(row.suppliers_approved ?? 0),
    suppliersPending: Number(row.suppliers_pending ?? 0),
  };
}

export interface CouncilCount {
  council: string;
  members: number;
}

/** Live members grouped by their council of record. Empty for a caller with no appointment. */
export async function getMembersByCouncil(client: RoamClient, channelId: string): Promise<CouncilCount[]> {
  const { data, error } = await rpc(client).rpc("channel_portal_members_by_council", { p_channel_id: channelId });
  if (error) throw new Error(`association: members-by-council failed: ${error.message}`);
  return ((data as any[]) ?? []).map((r) => ({ council: String(r.council), members: Number(r.members ?? 0) }));
}

/**
 * Channel order totals for a period (decision 5.3, Option B). Money stays in pence as integers all
 * the way to the render — the codebase formats with money.formatPence, and a float here would be a
 * rounding bug waiting for a big enough number.
 */
export interface PortalOrderTotals {
  ordersCount: number;
  gmvPence: number;
  feesPence: number;
  refundedCount: number;
  currency: string | null;
}

export async function getOrderTotals(
  client: RoamClient,
  channelId: string,
  from?: string | null,
  to?: string | null,
): Promise<PortalOrderTotals | null> {
  const { data, error } = await rpc(client).rpc("channel_portal_orders", {
    p_channel_id: channelId,
    p_from: from ?? null,
    p_to: to ?? null,
  });
  if (error) throw new Error(`association: order totals failed: ${error.message}`);
  const row = (data as any[])?.[0];
  if (!row) return null;
  return {
    ordersCount: Number(row.orders_count ?? 0),
    gmvPence: Number(row.gmv_pence ?? 0),
    feesPence: Number(row.fees_pence ?? 0),
    refundedCount: Number(row.refunded_count ?? 0),
    currency: row.currency ?? null,
  };
}

export interface VenueOrderTotals {
  venueId: string;
  venueName: string;
  ordersCount: number;
  gmvPence: number;
}

/** What the storefront did for each member venue. Totals only — no buyer, no line items, no times. */
export async function getOrderTotalsByVenue(
  client: RoamClient,
  channelId: string,
  from?: string | null,
  to?: string | null,
): Promise<VenueOrderTotals[]> {
  const { data, error } = await rpc(client).rpc("channel_portal_orders_by_venue", {
    p_channel_id: channelId,
    p_from: from ?? null,
    p_to: to ?? null,
  });
  if (error) throw new Error(`association: per-venue totals failed: ${error.message}`);
  return ((data as any[]) ?? []).map((r) => ({
    venueId: String(r.venue_id),
    venueName: String(r.venue_name ?? ""),
    ordersCount: Number(r.orders_count ?? 0),
    gmvPence: Number(r.gmv_pence ?? 0),
  }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */
