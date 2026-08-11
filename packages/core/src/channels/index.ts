/**
 * @roam/core/channels — the Food to Go marketplace's "one platform, two views" logic.
 *
 * A CHANNEL is a branded, filtered view over the one core (see migration 0116). `roam` is the
 * default channel — it shows everything. `f2g` (Food to Go) is a storefront that shows only the
 * venues tagged into it (venue_channels). This module is the transport-agnostic half:
 *
 *   - PURE resolution: normalise an incoming hostname and pick its channel from a domain map,
 *     falling back to the default. Unit-testable with no DB (the web shell's middleware calls the
 *     DB-backed wrapper; the *decision* it makes is these pure functions).
 *   - PURE theme parsing: turn the channel's stored `theme` jsonb into a typed, validated set of
 *     semantic tokens (brand/accent/paper/ink). The web shell maps those to CSS vars — the
 *     token→CSS-var name mapping is a rendering detail and does NOT live here.
 *   - Thin DB reads/writes: list channels, resolve a host, read/set a venue's channel tags.
 *
 * By law (ARCHITECTURE.md) this filtering rule lives here ONCE, so web, native and any future
 * partner surface all resolve a channel identically. No shell carries its own copy.
 */
import type { RoamClient } from "@roam/db";

/** The default channel's key: the unbranded, everything-included view. */
export const DEFAULT_CHANNEL_KEY = "roam";

/** Semantic theme tokens a channel may override on top of the base @roam/design palette. */
export interface ChannelTheme {
  brand?: string;
  accent?: string;
  paper?: string;
  ink?: string;
}

/** How a channel's storefront selects venues (channels.membership_mode). */
export type MembershipMode = "open" | "members";

/** A branded, filtered view over the core. */
export interface Channel {
  id: string;
  key: string;
  name: string;
  tagline: string | null;
  isDefault: boolean;
  theme: ChannelTheme;
  logoUrl: string | null;
  /**
   * 'open'    — the storefront shows all eligible venues near the point (by type).
   * 'members' — only venues tagged into this channel (venue_channels).
   * The default channel (roam) is always 'open'-equivalent (it shows everything).
   */
  membershipMode: MembershipMode;
}

/** One hostname → channel-key mapping row, as the pure resolver consumes it. */
export interface DomainMapping {
  host: string;
  channelKey: string;
}

// ---------------------------------------------------------------------------
// PURE helpers (no DB, no framework) — the unit-tested core of resolution.
// ---------------------------------------------------------------------------

/**
 * Reduce a raw Host / X-Forwarded-Host value to the bare lowercased hostname used as the
 * channel_domains key: no scheme, no path, no port, no trailing dot. Returns '' if nothing
 * usable remains (the caller then falls back to the default channel).
 */
export function normalizeHost(raw: string | null | undefined): string {
  if (!raw) return "";
  let h = raw.trim().toLowerCase();
  // A forwarded header can carry a list ("a.com, b.com"); the first hop is the client-facing host.
  if (h.includes(",")) h = h.split(",")[0]!.trim();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme
  h = h.replace(/[/?#].*$/, ""); // strip path/query/fragment
  h = h.replace(/:\d+$/, ""); // strip :port
  h = h.replace(/\.$/, ""); // strip fully-qualified trailing dot
  return h;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Whether a value is a usable CSS hex colour (#rgb or #rrggbb). */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value.trim());
}

/**
 * Validate the stored `theme` jsonb into a typed ChannelTheme. Only the four known semantic
 * keys are honoured and only when they are valid hex — an unknown or malformed value is dropped,
 * so a bad row can never inject arbitrary CSS into a shell.
 */
export function parseChannelTheme(raw: unknown): ChannelTheme {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const theme: ChannelTheme = {};
  for (const key of ["brand", "accent", "paper", "ink"] as const) {
    const v = src[key];
    if (isHexColor(v)) theme[key] = v.trim();
  }
  return theme;
}

/**
 * PURE host → channel-key decision. Given the full domain map and the default channel key, pick
 * the channel for a host: exact match first; otherwise the default. Case/port/scheme are handled
 * by normalizeHost, applied to both sides so the map may be stored in any of those forms.
 */
export function pickChannelKeyForHost(
  host: string | null | undefined,
  domains: DomainMapping[],
  defaultKey: string = DEFAULT_CHANNEL_KEY,
): string {
  const h = normalizeHost(host);
  if (!h) return defaultKey;
  for (const d of domains) {
    if (normalizeHost(d.host) === h) return d.channelKey;
  }
  return defaultKey;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Map a channels row to the domain Channel shape (validating the theme jsonb). */
export function rowToChannel(row: any): Channel {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    tagline: row.tagline ?? null,
    isDefault: !!row.is_default,
    theme: parseChannelTheme(row.theme),
    logoUrl: row.logo_url ?? null,
    membershipMode: row.membership_mode === "members" ? "members" : "open",
  };
}

// ---------------------------------------------------------------------------
// Thin DB reads/writes — resolution against the live domain map.
// ---------------------------------------------------------------------------

const CHANNEL_COLS = "id, key, name, tagline, is_default, theme, logo_url, membership_mode";

/** All active channels, default first. */
export async function listChannels(client: RoamClient): Promise<Channel[]> {
  const { data, error } = await (client as any)
    .from("channels")
    .select(CHANNEL_COLS)
    .eq("active", true)
    .order("is_default", { ascending: false })
    .order("key", { ascending: true });
  if (error) throw new Error(`channels: list failed: ${error.message}`);
  return ((data ?? []) as any[]).map(rowToChannel);
}

/** The single default channel (the host-resolution fallback). */
export async function getDefaultChannel(client: RoamClient): Promise<Channel | null> {
  const { data, error } = await (client as any)
    .from("channels")
    .select(CHANNEL_COLS)
    .eq("is_default", true)
    .eq("active", true)
    .maybeSingle();
  if (error) throw new Error(`channels: default lookup failed: ${error.message}`);
  return data ? rowToChannel(data) : null;
}

/** A channel by its stable key, or null. */
export async function getChannelByKey(
  client: RoamClient,
  key: string,
): Promise<Channel | null> {
  const { data, error } = await (client as any)
    .from("channels")
    .select(CHANNEL_COLS)
    .eq("key", key)
    .eq("active", true)
    .maybeSingle();
  if (error) throw new Error(`channels: key lookup failed: ${error.message}`);
  return data ? rowToChannel(data) : null;
}

/**
 * Resolve an incoming hostname to its channel, falling back to the default channel when the host
 * is unmapped. This is the one call the web middleware makes per request.
 */
export async function resolveChannelByHost(
  client: RoamClient,
  host: string | null | undefined,
): Promise<Channel | null> {
  const h = normalizeHost(host);
  if (h) {
    const { data, error } = await (client as any)
      .from("channel_domains")
      .select(`channel:channels(${CHANNEL_COLS})`)
      .eq("host", h)
      .maybeSingle();
    if (error) throw new Error(`channels: host resolve failed: ${error.message}`);
    const ch = data?.channel;
    if (ch && ch.active !== false) return rowToChannel(ch);
  }
  return getDefaultChannel(client);
}

/** The venue ids tagged into a channel (drives the storefront filter). */
export async function taggedVenueIds(
  client: RoamClient,
  channelId: string,
): Promise<string[]> {
  const { data, error } = await (client as any)
    .from("venue_channels")
    .select("venue_id")
    .eq("channel_id", channelId);
  if (error) throw new Error(`channels: tagged venues failed: ${error.message}`);
  return ((data ?? []) as any[]).map((r) => r.venue_id as string);
}

/** The keys of every channel a venue is tagged into (for the vendor console's channel toggles). */
export async function venueChannelKeys(
  client: RoamClient,
  venueId: string,
): Promise<string[]> {
  const { data, error } = await (client as any)
    .from("venue_channels")
    .select("channel:channels(key)")
    .eq("venue_id", venueId);
  if (error) throw new Error(`channels: venue channels failed: ${error.message}`);
  return ((data ?? []) as any[])
    .map((r) => r.channel?.key as string | undefined)
    .filter((k): k is string => !!k);
}

/**
 * The subset of the given venue ids that are tagged into a channel — a bulk membership check for a
 * discovery grid (which of these ~50 venues offer Food to Go). Empty input → empty result.
 */
export async function filterVenuesInChannel(
  client: RoamClient,
  channelId: string,
  venueIds: string[],
): Promise<string[]> {
  if (venueIds.length === 0) return [];
  const { data, error } = await (client as any)
    .from("venue_channels")
    .select("venue_id")
    .eq("channel_id", channelId)
    .in("venue_id", venueIds);
  if (error) throw new Error(`channels: bulk membership failed: ${error.message}`);
  return ((data ?? []) as any[]).map((r) => r.venue_id as string);
}

/** Whether a specific venue is tagged into a channel. */
export async function isVenueInChannel(
  client: RoamClient,
  channelId: string,
  venueId: string,
): Promise<boolean> {
  const { data, error } = await (client as any)
    .from("venue_channels")
    .select("venue_id")
    .eq("channel_id", channelId)
    .eq("venue_id", venueId)
    .maybeSingle();
  if (error) throw new Error(`channels: membership check failed: ${error.message}`);
  return !!data;
}

/**
 * Tag a venue into a channel (idempotent). `addedBy` records who onboarded it. RLS decides whether
 * the caller may write: a venue owner via their user client, or staff/service via the service client.
 */
export async function tagVenueIntoChannel(
  client: RoamClient,
  channelId: string,
  venueId: string,
  addedBy?: string | null,
): Promise<void> {
  const { error } = await (client as any)
    .from("venue_channels")
    .upsert(
      { channel_id: channelId, venue_id: venueId, added_by: addedBy ?? null },
      { onConflict: "channel_id,venue_id", ignoreDuplicates: true },
    );
  if (error) throw new Error(`channels: tag venue failed: ${error.message}`);
}

/** Remove a venue's tag from a channel. */
export async function untagVenueFromChannel(
  client: RoamClient,
  channelId: string,
  venueId: string,
): Promise<void> {
  const { error } = await (client as any)
    .from("venue_channels")
    .delete()
    .eq("channel_id", channelId)
    .eq("venue_id", venueId);
  if (error) throw new Error(`channels: untag venue failed: ${error.message}`);
}
