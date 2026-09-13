/**
 * Roam HQ — channel + roster administration (F2G B4a).
 *
 * The staff console's data layer for a marketplace channel: read its config + domains, browse its
 * `channel_members` roster, see onboarding progress, and edit its configuration — every mutation
 * attributed and written to `admin_audit_log` (via recordAudit), exactly like the other admin
 * actions. All of this runs with the service-role client under `adminProcedure`; there is no new
 * table, role or RLS — staff reach the service-managed roster only through this audited surface.
 *
 * Config writes reuse the @roam/core/channels PARSERS as validators, so a malformed value can never
 * be stored (a bad theme colour is dropped, an unknown surface resolves to 'roam', etc.) — the same
 * rules the read path applies, enforced once, on the way in.
 */
import type { RoamClient } from "@roam/db";
import { loose } from "./loose.js";
import { recordAudit, type AdminActor } from "./actions.js";
import {
  getChannelByKey,
  normalizeHost,
  parseChannelTheme,
  parseChannelNav,
  parseChannelSections,
  parseChannelSurface,
  type MembershipMode,
} from "../channels/index.js";

// ── roster browsing ─────────────────────────────────────────────────────────────────────────────

/** One roster row as the console shows it (safe projection + the matched venue, if any). */
export interface ChannelRosterRow {
  id: string;
  sourceName: string;
  sourceCouncil: string | null;
  sourceEmail: string | null;
  status: string;
  membershipRef: string;
  /** The matched venue id (for staff tag/untag into the channel), null until matched. */
  venueId: string | null;
  venue: { name: string; slug: string } | null;
  createdAt: string;
}

export interface ChannelRosterPage {
  rows: ChannelRosterRow[];
  hasMore: boolean;
  nextOffset: number;
}

/** Escape a user search term for a PostgREST ILIKE pattern (`%` and `_` are wildcards). */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A page of a channel's roster, newest first, filterable by status / council / name search.
 * Offset-paginated (mirrors venues_food_to_go_near's page_offset) with a +1 look-ahead for hasMore.
 * Reads via the service client — the caller (adminProcedure) has already verified staff membership.
 */
export async function channelRoster(
  client: RoamClient,
  args: {
    channelKey: string;
    status?: string | undefined;
    council?: string | undefined;
    q?: string | undefined;
    limit: number;
    offset: number;
  },
): Promise<ChannelRosterPage> {
  const channel = await getChannelByKey(client, args.channelKey);
  if (!channel) throw new Error(`admin: unknown channel '${args.channelKey}'`);

  let query = loose(client)
    .from("channel_members")
    .select("id, source_name, source_council, source_email, status, membership_ref, created_at, venue_id, venue:venues(name, slug)")
    .eq("channel_id", channel.id)
    .order("created_at", { ascending: false })
    .range(args.offset, args.offset + args.limit); // limit+1 rows → hasMore
  if (args.status) query = query.eq("status", args.status);
  if (args.council) query = query.eq("source_council", args.council);
  if (args.q && args.q.trim()) query = query.ilike("source_name", `%${escapeLike(args.q.trim())}%`);

  const { data, error } = await query;
  if (error) throw new Error(`admin: roster read failed: ${error.message}`);
  const raw = (data ?? []) as any[];
  const hasMore = raw.length > args.limit;
  const page = hasMore ? raw.slice(0, args.limit) : raw;
  return {
    rows: page.map((r) => {
      const v = Array.isArray(r.venue) ? r.venue[0] : r.venue;
      return {
        id: String(r.id),
        sourceName: String(r.source_name ?? ""),
        sourceCouncil: r.source_council ?? null,
        sourceEmail: r.source_email ?? null,
        status: String(r.status ?? ""),
        membershipRef: String(r.membership_ref ?? ""),
        venueId: r.venue_id ?? null,
        venue: v ? { name: String(v.name ?? ""), slug: String(v.slug ?? "") } : null,
        createdAt: String(r.created_at ?? ""),
      };
    }),
    hasMore,
    nextOffset: args.offset + page.length,
  };
}

// ── onboarding dashboard ────────────────────────────────────────────────────────────────────────

export interface ChannelOnboardingStats {
  total: number;
  byStatus: Record<string, number>;
  byCouncil: Record<string, number>;
}

/**
 * Onboarding progress for a channel: counts by status (the funnel) and by council. Tallied in JS
 * from a projected two-column read, PAGED past PostgREST's 1000-row default cap (the cap-proof
 * pattern from deliverOwnerDigest) so the totals are exact regardless of roster size — and it needs
 * no GROUP BY function, so B4a adds no migration.
 */
export async function channelOnboardingStats(
  client: RoamClient,
  channelKey: string,
): Promise<ChannelOnboardingStats> {
  const channel = await getChannelByKey(client, channelKey);
  if (!channel) throw new Error(`admin: unknown channel '${channelKey}'`);

  const PAGE = 1000;
  const byStatus: Record<string, number> = {};
  const byCouncil: Record<string, number> = {};
  let total = 0;
  let from = 0;
  for (;;) {
    const { data, error } = await loose(client)
      .from("channel_members")
      .select("status, source_council")
      .eq("channel_id", channel.id)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`admin: onboarding stats read failed: ${error.message}`);
    const rows = (data ?? []) as any[];
    for (const r of rows) {
      total++;
      const s = String(r.status ?? "unknown");
      byStatus[s] = (byStatus[s] ?? 0) + 1;
      const c = r.source_council ? String(r.source_council) : "—";
      byCouncil[c] = (byCouncil[c] ?? 0) + 1;
    }
    if (rows.length < PAGE) break;
    from += rows.length;
  }
  return { total, byStatus, byCouncil };
}

// ── config + domain writes (audited) ──────────────────────────────────────────────────────────────

/** A partial channel-config edit. Only the keys present are changed; each is validated on the way in. */
export interface ChannelConfigPatch {
  theme?: unknown;
  logoUrl?: string | null | undefined;
  surface?: unknown;
  sections?: unknown;
  nav?: unknown;
  membershipMode?: unknown;
}

/**
 * Edit a channel's configuration (theme / logo / surface / sections / nav / membership_mode), then
 * audit. Each field is run through the core parser/validator so a bad value can't be stored. The
 * `membership_mode` flip (the reversible open↔members switch) is one of these keys — staff-gated and
 * audited here; the UI additionally puts it behind a confirmation.
 */
export async function setChannelConfig(
  client: RoamClient,
  actor: AdminActor,
  channelKey: string,
  patch: ChannelConfigPatch,
): Promise<void> {
  const channel = await getChannelByKey(client, channelKey);
  if (!channel) throw new Error(`admin: unknown channel '${channelKey}'`);

  const update: Record<string, unknown> = {};
  if ("theme" in patch) update.theme = parseChannelTheme(patch.theme);
  if ("logoUrl" in patch) update.logo_url = patch.logoUrl == null ? null : String(patch.logoUrl).trim() || null;
  if ("surface" in patch) update.surface = parseChannelSurface(patch.surface);
  if ("sections" in patch) update.sections = parseChannelSections(patch.sections);
  if ("nav" in patch) update.nav = parseChannelNav(patch.nav);
  if ("membershipMode" in patch) {
    update.membership_mode = (patch.membershipMode === "members" ? "members" : "open") as MembershipMode;
  }
  if (Object.keys(update).length === 0) throw new Error("admin: no channel-config changes supplied");

  const { error } = await loose(client).from("channels").update(update).eq("key", channelKey);
  if (error) throw new Error(`admin: channel-config write failed: ${error.message}`);
  await recordAudit(client, actor, {
    action: "set_channel_config",
    entityType: "channel",
    entityId: channel.id,
    detail: { channel: channelKey, changed: Object.keys(update), values: update },
  });
}

/** Onboard a hostname to a channel (a row in channel_domains — pairs with the config-driven
 *  middleware resolution), then audit. Host is normalised; a duplicate is a clean error. */
export async function addChannelDomain(
  client: RoamClient,
  actor: AdminActor,
  channelKey: string,
  host: string,
): Promise<void> {
  const channel = await getChannelByKey(client, channelKey);
  if (!channel) throw new Error(`admin: unknown channel '${channelKey}'`);
  const h = normalizeHost(host);
  if (!h) throw new Error("admin: a valid hostname is required");
  const { error } = await loose(client).from("channel_domains").insert({ host: h, channel_id: channel.id });
  if (error) throw new Error(`admin: add domain failed: ${error.message}`);
  await recordAudit(client, actor, {
    action: "add_channel_domain",
    entityType: "channel",
    entityId: channel.id,
    detail: { channel: channelKey, host: h },
  });
}

/** Remove a hostname from a channel, then audit. */
export async function removeChannelDomain(
  client: RoamClient,
  actor: AdminActor,
  channelKey: string,
  host: string,
): Promise<void> {
  const channel = await getChannelByKey(client, channelKey);
  if (!channel) throw new Error(`admin: unknown channel '${channelKey}'`);
  const h = normalizeHost(host);
  const { error } = await loose(client)
    .from("channel_domains")
    .delete()
    .eq("host", h)
    .eq("channel_id", channel.id);
  if (error) throw new Error(`admin: remove domain failed: ${error.message}`);
  await recordAudit(client, actor, {
    action: "remove_channel_domain",
    entityType: "channel",
    entityId: channel.id,
    detail: { channel: channelKey, host: h },
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
