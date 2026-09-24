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

/**
 * One row of the portal's members list. Decision 5.2 Option A: business, venue, council, membership
 * number, status, activation date — and no personal contact details, which are not columns of the
 * RPC at all rather than columns this interface declines to declare.
 */
export interface PortalMemberRow {
  memberId: string;
  business: string;
  /** Null until the Association introduces membership numbers in 2027. */
  memberNo: string | null;
  venueId: string | null;
  venueName: string | null;
  venueSlug: string | null;
  council: string | null;
  status: string;
  /** When someone claimed this roster row. Null while it is still unclaimed. */
  activatedAt: string | null;
}

export interface PortalMembersPage {
  rows: PortalMemberRow[];
  /** Total matching rows, for paging. Comes from the same query as the page it labels. */
  total: number;
}

/**
 * `| undefined` is spelled out on every optional field because the workspace runs
 * `exactOptionalPropertyTypes`. A zod-parsed input arrives with the key present and the value
 * undefined, which that flag treats as distinct from the key being absent.
 */
export interface PortalMembersFilter {
  status?: string | null | undefined;
  council?: string | null | undefined;
  query?: string | null | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function getPortalMembers(
  client: RoamClient,
  channelId: string,
  filter: PortalMembersFilter = {},
): Promise<PortalMembersPage> {
  const { data, error } = await rpc(client).rpc("channel_portal_members", {
    p_channel_id: channelId,
    p_status: filter.status ?? null,
    p_council: filter.council ?? null,
    p_query: filter.query ?? null,
    p_limit: filter.limit ?? 50,
    p_offset: filter.offset ?? 0,
  });
  if (error) throw new Error(`association: members list failed: ${error.message}`);
  const raw = (data as any[]) ?? [];
  return {
    // total_count rides on every row; an empty page legitimately means zero matches.
    total: raw.length > 0 ? Number(raw[0].total_count ?? 0) : 0,
    rows: raw.map((r) => ({
      memberId: String(r.member_id),
      business: String(r.business ?? ""),
      memberNo: r.member_no ?? null,
      venueId: r.venue_id ?? null,
      venueName: r.venue_name ?? null,
      venueSlug: r.venue_slug ?? null,
      council: r.council ?? null,
      status: String(r.status ?? ""),
      activatedAt: r.activated_at ?? null,
    })),
  };
}

/** The members-list CSV header, in the order the export writes them. */
export const MEMBERS_CSV_COLUMNS = [
  "Business",
  "Membership number",
  "Venue",
  "Council",
  "Status",
  "Activated",
] as const;

/**
 * Escape one CSV field per RFC 4180: quote when the value contains a comma, quote, CR or LF, and
 * double any embedded quotes.
 *
 * There is one extra rule that is not RFC 4180 and is not optional. A field beginning with `=`,
 * `+`, `-`, `@`, tab or CR is prefixed with a single quote, because Excel and Sheets treat such a
 * value as a FORMULA. A member called `=cmd|'/c calc'!A1` would otherwise become an attack on
 * whoever opens the export — and this data arrives from a partner's CRM, so its contents are not
 * ours to trust. The prefix is the documented defence and it is visible in the cell rather than
 * silently altering the value.
 */
export function csvField(value: unknown): string {
  const s = value == null ? "" : String(value);
  const injectionRisk = /^[=+\-@\t\r]/.test(s);
  const body = injectionRisk ? `'${s}` : s;
  return /[",\r\n]/.test(body) ? `"${body.replace(/"/g, '""')}"` : body;
}

/** Render the members list as CSV. CRLF line endings, as RFC 4180 specifies. */
export function membersToCsv(rows: PortalMemberRow[]): string {
  const lines = [MEMBERS_CSV_COLUMNS.map(csvField).join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvField(r.business),
        csvField(r.memberNo ?? ""),
        csvField(r.venueName ?? ""),
        csvField(r.council ?? ""),
        csvField(r.status),
        csvField(r.activatedAt ? r.activatedAt.slice(0, 10) : ""),
      ].join(","),
    );
  }
  return lines.join("\r\n");
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
