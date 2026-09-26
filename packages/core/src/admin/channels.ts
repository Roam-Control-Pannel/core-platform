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
import { maskEmail } from "../activation/index.js";
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
  /**
   * The roster e-mail, MASKED (`i\u2022\u2022\u2022@b\u2022\u2022\u2022.co.uk`), never the address itself. 2.5: the full
   * value is personal data belonging to the Association's members, and a list screen that ships it
   * to every staff browser on every page load puts it into screenshares, screenshots and devtools
   * with no record that anyone looked. Masking HERE rather than in the UI is the point — a CSS or
   * JSX change cannot undo it, because the address never crosses the wire.
   *
   * To see a real one, staff call `revealMemberEmail`, which is audited.
   */
  sourceEmailMasked: string | null;
  /**
   * Whether an address exists at all. The invite/activation buttons need to know this and nothing
   * more; they never needed the address, because the send happens server-side.
   */
  hasEmail: boolean;
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
        sourceEmailMasked: r.source_email ? maskEmail(r.source_email) : null,
        hasEmail: Boolean(r.source_email && String(r.source_email).trim()),
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

// ── the partner's own officers (F2G plan 3.1, migration 0156) ───────────────────────────────────
//
// Appointing an officer hands a partner organisation read access to everything about THEIR channel.
// It is therefore a privileged act: Roam staff only, through adminProcedure, and audited like every
// other one. `channel_admins` has no client write policy at all, so this path — service-role under a
// verified staff session — is the only way a row gets created, changed or removed.
//
// Appointment is BY PROFILE ID, not by e-mail. `profiles` holds no e-mail (it lives in auth.users),
// and resolving one would mean scanning the auth admin API; Roam HQ already has a people search
// (adminSearch.users), so the console finds the person and passes their id. That also makes the act
// deliberate: you appoint a specific account you have looked at, not a string you typed.

/** The partner officers of one channel, as the console lists them. */
export interface ChannelOfficerRow {
  profileId: string;
  handle: string | null;
  displayName: string | null;
  role: ChannelAdminRole;
  note: string | null;
  createdAt: string;
}

/** A partner officer's authority within their own channel. Mirrors migration 0156's check. */
export type ChannelAdminRole = "officer" | "viewer";

function parseChannelAdminRole(value: unknown): ChannelAdminRole {
  return value === "officer" ? "officer" : "viewer";
}

/** Who holds a role at this channel. */
export async function listChannelOfficers(
  client: RoamClient,
  channelKey: string,
): Promise<ChannelOfficerRow[]> {
  const channel = await getChannelByKey(client, channelKey);
  if (!channel) throw new Error(`admin: unknown channel '${channelKey}'`);

  const { data, error } = await loose(client)
    .from("channel_admins")
    .select("profile_id, role, note, created_at, profiles(handle, display_name)")
    .eq("channel_id", channel.id)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`admin: officer list failed: ${error.message}`);

  return ((data ?? []) as any[]).map((r) => ({
    profileId: String(r.profile_id),
    handle: r.profiles?.handle ?? null,
    displayName: r.profiles?.display_name ?? null,
    role: parseChannelAdminRole(r.role),
    note: r.note ?? null,
    createdAt: String(r.created_at),
  }));
}

/**
 * Appoint someone, or change the role they already hold.
 *
 * Upsert on (channel_id, profile_id) — the unique index in 0156 — so re-appointing updates the role
 * rather than leaving two rows whose precedence nobody has defined. This is a plain unique index, not
 * a partial one, so PostgREST can use it as a conflict arbiter.
 */
export async function setChannelOfficer(
  client: RoamClient,
  actor: AdminActor,
  channelKey: string,
  profileId: string,
  role: ChannelAdminRole,
  note?: string | null,
): Promise<void> {
  const channel = await getChannelByKey(client, channelKey);
  if (!channel) throw new Error(`admin: unknown channel '${channelKey}'`);

  const { error } = await loose(client)
    .from("channel_admins")
    .upsert(
      {
        channel_id: channel.id,
        profile_id: profileId,
        role: parseChannelAdminRole(role),
        note: note ?? null,
        created_by: actor.id,
      },
      { onConflict: "channel_id,profile_id" },
    );
  if (error) throw new Error(`admin: officer appointment failed: ${error.message}`);

  await recordAudit(client, actor, {
    action: "set_channel_officer",
    entityType: "channel",
    entityId: channel.id,
    detail: { channel: channelKey, profileId, role: parseChannelAdminRole(role) },
  });
}

// ── the feature-request queue (F2G plan 3.4, migration 0159) ────────────────────────────────────
//
// Partners file requests; Roam triages them. The table has no client UPDATE policy, so this
// service-role path is the only way a status or a reply is ever written — and every change is
// audited, because "who declined our request, and when" is a question an association will ask.

/** One request as the HQ queue shows it, with the channel it came from. */
export interface FeatureRequestRow {
  id: string;
  channelId: string;
  channelKey: string | null;
  channelName: string | null;
  createdBy: string | null;
  title: string;
  detail: string | null;
  category: string;
  status: string;
  roamNotes: string | null;
  createdAt: string;
}

/** Every partner's requests, newest first; optionally narrowed to one status. */
export async function listFeatureRequestQueue(
  client: RoamClient,
  opts: { status?: string | null; limit?: number } = {},
): Promise<FeatureRequestRow[]> {
  let q = loose(client)
    .from("channel_feature_requests")
    .select("id, channel_id, created_by, title, detail, category, status, roam_notes, created_at, channels(key, name)")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  if (opts.status) q = q.eq("status", opts.status);

  const { data, error } = await q;
  if (error) throw new Error(`admin: feature-request queue failed: ${error.message}`);
  return ((data ?? []) as any[]).map((r) => ({
    id: String(r.id),
    channelId: String(r.channel_id),
    channelKey: r.channels?.key ?? null,
    channelName: r.channels?.name ?? null,
    createdBy: r.created_by ?? null,
    title: String(r.title ?? ""),
    detail: r.detail ?? null,
    category: String(r.category ?? "other"),
    status: String(r.status ?? "new"),
    roamNotes: r.roam_notes ?? null,
    createdAt: String(r.created_at),
  }));
}

/**
 * Triage a request: set its status and/or Roam's reply, then audit.
 *
 * Returns the row as it now stands, including `created_by` and the channel — the caller needs both
 * to notify the officer who filed it, and re-reading here means the notification describes what was
 * actually stored rather than what was requested.
 */
export async function setFeatureRequestStatus(
  client: RoamClient,
  actor: AdminActor,
  id: string,
  patch: { status?: string | null; roamNotes?: string | null },
): Promise<FeatureRequestRow | null> {
  const update: Record<string, unknown> = {};
  if (patch.status) update.status = patch.status;
  if ("roamNotes" in patch) update.roam_notes = patch.roamNotes?.trim() || null;
  if (Object.keys(update).length === 0) throw new Error("admin: no feature-request changes supplied");

  const { data, error } = await loose(client)
    .from("channel_feature_requests")
    .update(update)
    .eq("id", id)
    .select("id, channel_id, created_by, title, detail, category, status, roam_notes, created_at, channels(key, name)")
    .maybeSingle();
  if (error) throw new Error(`admin: feature-request update failed: ${error.message}`);
  if (!data) return null;

  const row = data as any;
  await recordAudit(client, actor, {
    action: "set_channel_feature_request",
    entityType: "channel_feature_request",
    entityId: id,
    detail: { channel: row.channels?.key ?? null, changed: Object.keys(update), status: row.status },
  });

  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    channelKey: row.channels?.key ?? null,
    channelName: row.channels?.name ?? null,
    createdBy: row.created_by ?? null,
    title: String(row.title ?? ""),
    detail: row.detail ?? null,
    category: String(row.category ?? "other"),
    status: String(row.status ?? "new"),
    roamNotes: row.roam_notes ?? null,
    createdAt: String(row.created_at),
  };
}

/** Revoke someone's role at this channel. Idempotent: removing a role nobody holds is not an error. */
export async function removeChannelOfficer(
  client: RoamClient,
  actor: AdminActor,
  channelKey: string,
  profileId: string,
): Promise<void> {
  const channel = await getChannelByKey(client, channelKey);
  if (!channel) throw new Error(`admin: unknown channel '${channelKey}'`);

  const { error } = await loose(client)
    .from("channel_admins")
    .delete()
    .eq("channel_id", channel.id)
    .eq("profile_id", profileId);
  if (error) throw new Error(`admin: officer removal failed: ${error.message}`);

  await recordAudit(client, actor, {
    action: "remove_channel_officer",
    entityType: "channel",
    entityId: channel.id,
    detail: { channel: channelKey, profileId },
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── PII: revealing one roster e-mail, on the record ─────────────────────────────────────────────

/**
 * Return ONE member's real e-mail address and write an audit row for having done so (F2G plan 2.5).
 *
 * WHY THIS EXISTS RATHER THAN JUST SENDING THE ADDRESS WITH THE LIST. Roam staff are trusted, so
 * this is not a defence against them — it is two other things. It keeps members' contact details out
 * of the incidental places a list screen leaks into (a screenshare, a screenshot in a ticket, an
 * open devtools panel), and it makes deliberate access to personal data *accountable*: who looked,
 * at whose details, and when. That accountability is the part a data-protection regime actually asks
 * for, and a masked list with no reveal path would simply have pushed staff to the database console,
 * where nothing is recorded at all.
 *
 * Returns null when the roster holds no address — a legitimate and common answer (plan §3.2: those
 * members have no self-serve path), and not something to audit as a PII read, because there was no
 * personal data to read.
 */
export async function revealMemberEmail(
  client: RoamClient,
  actor: AdminActor,
  args: { channelKey: string; memberId: string },
): Promise<{ email: string | null }> {
  const channel = await getChannelByKey(client, args.channelKey);
  if (!channel) throw new Error(`admin: unknown channel '${args.channelKey}'`);

  const { data, error } = await loose(client)
    .from("channel_members")
    .select("id, source_email")
    // Scoped to the channel as well as the id: a member id from one partner must not resolve
    // against another, even for staff who could legitimately read both.
    .eq("id", args.memberId)
    .eq("channel_id", channel.id)
    .maybeSingle();
  if (error) throw new Error(`admin: member read failed: ${error.message}`);
  if (!data) throw new Error("admin: member not found on this channel");

  const email = (data.source_email as string | null) ?? null;
  if (!email) return { email: null };

  // Audited BEFORE returning: if the write fails, recordAudit throws and the caller gets nothing.
  // An unrecorded PII read is the one outcome this function must not produce.
  await recordAudit(client, actor, {
    action: "reveal_member_email",
    entityType: "channel_member",
    entityId: args.memberId,
    // The channel, not the address — an audit log that quotes what it protects is a second copy of
    // it, and this table is append-only and long-lived.
    detail: { channel: args.channelKey },
  });

  return { email };
}
