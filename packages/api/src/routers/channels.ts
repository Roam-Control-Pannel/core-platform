/**
 * channels router — the Food to Go marketplace's "one platform, two views" surface.
 *
 * A channel is a branded, filtered VIEW over the one core (migration 0116): `roam` shows
 * everything; `f2g` is the Food to Go storefront showing only its tagged venues. All of the
 * decision logic lives in @roam/core/channels (resolution, theme validation) — this router is the
 * thin transport over it. Reads are public (a storefront themes itself before anyone signs in).
 *
 * Resolution split (see ARCHITECTURE.md — Shape-B standalone API keyed by JWT, not host): the web
 * shell resolves the incoming HOSTNAME to a channel and forwards its key as `x-roam-channel`. The
 * API never sees the host. `resolve` exists so that middleware can do the host→channel lookup
 * against the live domain map; `current` reports the channel the header already selected.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { RoamClient } from "@roam/db";
import { channels, f2g } from "@roam/core";
import { router, publicProcedure, protectedProcedure, escalateToService } from "../trpc.js";
import { notifyOps } from "../observability/ops.js";

/**
 * Feature-flag gates for branded channels: a channel key here only resolves live while its flag is
 * on. This keeps a channel's whole storefront DORMANT until launch — a request on the f2g host
 * falls back to the default channel (Roam chrome), not a half-built storefront, while the flag is
 * off. (The vendor dashboard + Roam-side badges gate on the same flag via useF2gEnabled separately.)
 */
const CHANNEL_FLAGS: Record<string, string> = { f2g: "marketplace.f2g.enabled" };

/**
 * Map a listing definer's refusal to a tRPC error. `ListingError` carries the reason the DATABASE
 * gave, so the message a venue owner sees is the one the check that actually refused them produced,
 * rather than a guess made by pattern-matching an error string in the router.
 */
function asListingError(e: unknown, fallback: string): TRPCError {
  if (e instanceof channels.ListingError) {
    return new TRPCError({ code: "FORBIDDEN", message: e.message });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: e instanceof Error ? e.message : fallback,
  });
}

/** True when `channelKey` is flag-gated and its flag is currently OFF (so it must not resolve live). */
export async function channelGatedOff(db: RoamClient, channelKey: string): Promise<boolean> {
  const flag = CHANNEL_FLAGS[channelKey];
  if (!flag) return false; // ungated channels (e.g. the default) always resolve
  const { data } = await (db as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => { maybeSingle: () => Promise<{ data: { enabled: boolean } | null }> };
      };
    };
  })
    .from("feature_flags")
    .select("enabled")
    .eq("key", flag)
    .maybeSingle();
  return !data?.enabled;
}

/** Resolve a channel by key or throw a clean NOT_FOUND — used by the self-serve tag paths. */
async function requireChannel(db: RoamClient, key: string) {
  const channel = await channels.getChannelByKey(db, key);
  if (!channel) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Unknown channel '${key}'.` });
  }
  if (channel.isDefault) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The default channel shows every venue; it can't be tagged into.",
    });
  }
  return channel;
}

/** One member in the public directory (C2) — safe columns + the matched venue's public basics. */
export interface DirectoryEntry {
  memberId: string;
  name: string;
  council: string | null;
  status: string;
  venue: { id: string; slug: string | null; name: string; locality: string | null; rating: number | null } | null;
  distanceM: number | null;
}

export interface DirectoryPage {
  entries: DirectoryEntry[];
  hasMore: boolean;
  nextOffset: number;
}

export const channelsRouter = router({
  /** Every active channel (default first) — for admin pickers and shell bootstrapping. */
  list: publicProcedure.query(async ({ ctx }) => {
    return channels.listChannels(ctx.db);
  }),

  /**
   * Resolve a hostname to its channel against the live domain map, falling back to the default
   * channel when the host is unmapped. The web middleware calls this once per request to decide
   * which channel key to forward and which theme to apply.
   */
  resolve: publicProcedure
    .input(z.object({ host: z.string().max(255) }))
    .query(async ({ ctx, input }) => {
      const channel = await channels.resolveChannelByHost(ctx.db, input.host);
      // A branded channel whose feature flag is off stays dormant: resolve it to the default view.
      if (channel && !channel.isDefault && (await channelGatedOff(ctx.db, channel.key))) {
        return (await channels.getDefaultChannel(ctx.db)) ?? channel;
      }
      return channel;
    }),

  /**
   * The channel the caller is already on (from the `x-roam-channel` header), with its theme.
   * Falls back to the default channel if the header is missing or names an unknown channel.
   */
  current: publicProcedure.query(async ({ ctx }): Promise<(channels.Channel & { gatedOff?: boolean }) | null> => {
    const channel = await channels.getChannelByKey(ctx.db, ctx.channelKey);
    // A branded channel whose feature flag is OFF is reported AS ITSELF with `gatedOff: true`, so the
    // web shell can show that brand's maintenance page. (Until holistic plan Phase 1.4 this silently
    // substituted the default channel — the Association's domain quietly became Roam, and nobody was
    // told.) It is also an incident: alert, deduped per channel.
    if (channel && !channel.isDefault && (await channelGatedOff(ctx.db, channel.key))) {
      void notifyOps({
        key: `channel.gated-off:${channel.key}`,
        severity: "warn",
        title: `Channel '${channel.key}' is serving its maintenance page (feature flag off)`,
        detail: `Flag ${CHANNEL_FLAGS[channel.key]} is off or missing; requests on this channel's host see the maintenance notice.`,
      });
      return { ...channel, gatedOff: true };
    }
    return channel ?? (await channels.getDefaultChannel(ctx.db));
  }),

  /**
   * The full host → channel-key map (from channel_domains). Public and low-cardinality; the web
   * middleware reads it (via the CDN-cached /api/channel-map endpoint) to resolve a host to its
   * channel from config, so onboarding a whitelabel domain is a row here rather than a redeploy.
   */
  domains: publicProcedure.query(async ({ ctx }) => {
    return channels.listChannelDomains(ctx.db);
  }),

  /** A channel by its stable key, or null. */
  get: publicProcedure
    .input(z.object({ key: z.string().min(1).max(32) }))
    .query(async ({ ctx, input }) => {
      return channels.getChannelByKey(ctx.db, input.key);
    }),

  /**
   * The venue ids tagged into a channel — the storefront's supply list. Public: it drives the
   * public F2G storefront filter. Returns [] for the default channel (which is never tagged; it
   * shows everything, so a channel filter is meaningless there).
   */
  venueIds: publicProcedure
    .input(z.object({ key: z.string().min(1).max(32) }))
    .query(async ({ ctx, input }) => {
      const channel = await channels.getChannelByKey(ctx.db, input.key);
      if (!channel || channel.isDefault) return { channelId: channel?.id ?? null, venueIds: [] };
      const venueIds = await channels.taggedVenueIds(ctx.db, channel.id);
      return { channelId: channel.id, venueIds };
    }),

  /** The channel keys a venue is tagged into — drives the vendor console's channel toggles. */
  venueChannels: publicProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return channels.venueChannelKeys(ctx.db, input.venueId);
    }),

  /**
   * Bulk membership: of the given venue ids, which are tagged into the channel. Powers the Roam-side
   * "Order ahead" badge across a discovery grid without downloading the channel's whole id list.
   * Returns [] for the default channel (which shows everything) or an unknown key.
   */
  venuesInChannel: publicProcedure
    .input(
      z.object({
        key: z.string().min(1).max(32),
        venueIds: z.array(z.string().uuid()).max(200),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (input.venueIds.length === 0) return { channelId: null, venueIds: [] as string[] };
      const channel = await channels.getChannelByKey(ctx.db, input.key);
      if (!channel || channel.isDefault) return { channelId: channel?.id ?? null, venueIds: [] as string[] };
      const venueIds = await channels.filterVenuesInChannel(ctx.db, channel.id, input.venueIds);
      return { channelId: channel.id, venueIds };
    }),

  /**
   * SELF-SERVE onboarding: a venue owner LISTS their OWN claimed venue on a channel (e.g. on Food to
   * Go). Listing is not joining — the row is always `role = 'listed'`, and membership is the
   * Association's to grant (0160).
   *
   * CHANGED (0161): authority is no longer the `venue_channels` owner-write policy, which is gone.
   * That policy constrained which venue could be written but could not see the region fence below,
   * so an owner could write the table directly through PostgREST into any channel. The write now
   * goes through `tag_venue_listing`, a SECURITY DEFINER function revoked from every client role,
   * which re-checks ownership itself — so this router is the only thing that can reach it, and the
   * fence cannot be walked around. Staff tagging of any venue stays a separate audited path
   * (adminActions.setVenueChannel).
   */
  tagVenue: protectedProcedure
    .input(z.object({ venueId: z.string().uuid(), channelKey: z.string().min(1).max(32) }))
    .mutation(async ({ ctx, input }) => {
      const channel = await requireChannel(ctx.db, input.channelKey);
      // Food to Go is an NI-only marketplace: a venue outside Northern Ireland can never list on
      // it (it would never surface on the NI-fenced storefront anyway). Enforced server-side so a
      // direct API call can't bypass the hidden-in-UI Food to Go tab.
      if (
        input.channelKey === f2g.F2G_CHANNEL_KEY &&
        !(await f2g.isVenueInFoodToGoRegion(ctx.db, input.venueId))
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Food to Go is only available to venues in Northern Ireland.",
        });
      }
      const { data: me } = await ctx.db.auth.getUser();
      const actorId = me.user?.id;
      if (!actorId) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to list a venue." });
      try {
        // Escalate ONLY here, after the fence, and pass the caller's own id — the definer decides
        // whether they own the venue. The service client is never handed the caller's intent
        // unchecked.
        await channels.listVenueOnChannel(escalateToService(ctx.env), channel.id, input.venueId, actorId);
      } catch (e) {
        throw asListingError(e, "Failed to list the venue.");
      }
      return { ok: true as const };
    }),

  /**
   * The public MEMBERS DIRECTORY (C2). Searches the channel's LIVE members server-side via the
   * PII-safe channel_members_search definer RPC (0144) — only safe columns ever leave the DB — and
   * pages them. Radius is optional (omit `near`/`radiusM` for a nationwide search; the D5/D6 fix).
   */
  directory: publicProcedure
    .input(
      z.object({
        channelKey: z.string().min(1).max(32),
        q: z.string().trim().max(120).optional(),
        council: z.string().trim().max(120).optional(),
        near: z.object({ lat: z.number(), lng: z.number() }).optional(),
        radiusM: z.number().int().min(0).max(200_000).optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }): Promise<DirectoryPage> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rpc = (ctx.db as any).rpc.bind(ctx.db) as (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }>;
      const { data, error } = await rpc("channel_members_search", {
        p_channel_key: input.channelKey,
        p_query: input.q ?? null,
        p_council: input.council ?? null,
        p_lat: input.near?.lat ?? null,
        p_lng: input.near?.lng ?? null,
        p_radius_m: input.radiusM ?? null,
        p_limit: input.limit + 1, // +1 → hasMore
        p_offset: input.offset,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = (data ?? []) as any[];
      const hasMore = raw.length > input.limit;
      const page = hasMore ? raw.slice(0, input.limit) : raw;
      return {
        entries: page.map((r) => ({
          memberId: String(r.member_id),
          name: String(r.name ?? ""),
          council: r.council ?? null,
          status: String(r.status ?? ""),
          venue: r.venue_id
            ? {
                id: String(r.venue_id),
                slug: r.venue_slug ?? null,
                name: String(r.venue_name ?? ""),
                locality: r.venue_locality ?? null,
                rating: r.venue_rating ?? null,
              }
            : null,
          distanceM: r.distance_m ?? null,
        })),
        hasMore,
        nextOffset: input.offset + page.length,
      };
    }),

  /** Self-serve: a venue owner removes their own venue from a channel. RLS scopes it to the owner. */
  /**
   * Withdraw a listing. Same shape as tagVenue since 0161: the definer checks ownership, and refuses
   * to remove a `member` tag — an owner may withdraw their own listing, but resigning the
   * Association's membership on its behalf would silently un-rank a member the roster placed.
   */
  untagVenue: protectedProcedure
    .input(z.object({ venueId: z.string().uuid(), channelKey: z.string().min(1).max(32) }))
    .mutation(async ({ ctx, input }) => {
      const channel = await requireChannel(ctx.db, input.channelKey);
      const { data: me } = await ctx.db.auth.getUser();
      const actorId = me.user?.id;
      if (!actorId) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to unlist a venue." });
      try {
        await channels.unlistVenueFromChannel(escalateToService(ctx.env), channel.id, input.venueId, actorId);
      } catch (e) {
        throw asListingError(e, "Failed to unlist the venue.");
      }
      return { ok: true as const };
    }),
});
