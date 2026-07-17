/**
 * Events router — community-posted local "what's on" (0099_events.sql).
 *
 * Reads are PUBLIC (browse a town's events signed-out, same posture as townHall/venues.near);
 * writes are PROTECTED and act as the caller on their own rows (RLS author_id = auth.uid() is the
 * real gate). An event is a Town Hall post with a date + a place: locality-scoped, optimistic
 * moderation, author-owned, with an optional venue tie and a geo point for "near me".
 *
 *   listByLocality (public)    — a town's upcoming events, soonest-first (optionally include past).
 *   near           (public)    — upcoming events near a (lat,lng) via the events_near RPC.
 *   byId           (public)    — one event + author/venue embeds + the caller's "interested" state.
 *   create         (protected) — post an event on the locality you're browsing.
 *   update         (protected) — edit your own event.
 *   cancel         (protected) — mark your own event cancelled (stays visible, flagged).
 *   remove         (protected) — delete your own event.
 *   toggleInterest (protected) — add/remove your "interested" mark; count is trigger-maintained.
 *   mine           (protected) — events you created (for a "my events" view).
 *   reportEvent    (protected) — file a user_report into moderation_queue (the report-then-act backstop).
 *
 * The API owns the locality SLUG (web sends the place NAME; localitySlug() derives the key), and
 * the `events` table isn't in the generated DB types, so the client is loose-typed at each call
 * (same idiom as townHall). Every resolver returns an INLINE structural object so no named type
 * leaks into AppRouter (TS2883/4023).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";
import { localitySlug, localityLabel } from "../town-hall.js";
import {
  EVENT_CATEGORIES,
  shapeEvent,
  orNull,
  upcomingOrClause,
  eventHasPlace,
  endsBeforeStarts,
  type RawEvent,
} from "../events.js";

/* ── loose client shapes (events isn't in the generated DB types) ─────────────────────────── */

type PgResult<T> = { data: T; error: { message: string; code?: string } | null };
type LooseDb = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc: (fn: string, args: Record<string, unknown>) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  auth: { getUser: () => Promise<{ data: { user: { id: string } | null }; error: unknown }> };
};

const categorySchema = z.enum(EVENT_CATEGORIES);

const AUTHOR = "author:profiles!events_author_id_fkey(id, handle, display_name, avatar_url)";
const VENUE = "venue:venues!events_venue_id_fkey(id, name, slug)";
const EVENT_COLS = `id, locality, locality_label, title, description, category, starts_at, ends_at, venue_id, location_name, lat, lng, url, cover_image_url, interested_count, status, created_at, ${AUTHOR}, ${VENUE}`;

/** Resolve the caller (writes only). RLS is the real gate; this gives a friendly 401 + the id. */
async function callerId(db: LooseDb): Promise<string> {
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Could not resolve the signed-in user." });
  }
  return data.user.id;
}
async function maybeCallerId(db: LooseDb): Promise<string | null> {
  try {
    const { data } = await db.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

/** The set of event ids the caller has marked "interested", scoped to the shown ids. */
async function viewerInterest(db: LooseDb, eventIds: string[]): Promise<Set<string>> {
  const caller = await maybeCallerId(db);
  if (!caller || eventIds.length === 0) return new Set();
  const { data } = (await db
    .from("event_interest")
    .select("event_id")
    .eq("user_id", caller)
    .in("event_id", eventIds)) as PgResult<{ event_id: string }[] | null>;
  return new Set((data ?? []).map((r) => r.event_id));
}

const title = z.string().trim().min(1).max(140);
const description = z.string().trim().max(8000);
const locationName = z.string().trim().max(200);
const isoDate = z.string().datetime({ offset: true });

export const eventsRouter = router({
  /** Public: a locality's events, soonest-first. Upcoming only unless includePast is set. */
  listByLocality: publicProcedure
    .input(
      z.object({
        localityName: z.string().trim().min(1).max(120),
        category: categorySchema.optional(),
        includePast: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      let slug: string;
      let label: string;
      try {
        slug = localitySlug(input.localityName);
        label = localityLabel(input.localityName);
      } catch {
        return { locality: "", localityLabel: input.localityName, events: [] };
      }
      let q = db.from("events").select(EVENT_COLS).eq("locality", slug);
      if (input.category) q = q.eq("category", input.category);
      if (!input.includePast) {
        // Upcoming = hasn't ended yet (or, with no end, hasn't started yet). Ongoing events stay.
        q = q.or(upcomingOrClause(new Date().toISOString()));
      }
      const { data, error } = (await q.order("starts_at", { ascending: true }).limit(input.limit)) as PgResult<RawEvent[] | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load events: ${error.message}` });
      }
      const rows = data ?? [];
      const interested = await viewerInterest(db, rows.map((r) => r.id));
      return { locality: slug, localityLabel: label, events: rows.map((e) => shapeEvent(e, interested.has(e.id))) };
    }),

  /** Public: upcoming events near a (lat,lng), nearest-first, within radius. */
  near: publicProcedure
    .input(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        radiusM: z.number().int().min(100).max(100000).default(30000),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db.rpc("events_near", {
        lat: input.lat,
        lng: input.lng,
        radius_m: input.radiusM,
        max_results: input.limit,
      })) as PgResult<
        {
          id: string;
          title: string;
          category: string | null;
          starts_at: string;
          ends_at: string | null;
          locality: string;
          locality_label: string;
          venue_id: string | null;
          location_name: string | null;
          interested_count: number;
          distance_m: number;
        }[] | null
      >;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load nearby events: ${error.message}` });
      }
      const rows = data ?? [];
      const interested = await viewerInterest(db, rows.map((r) => r.id));
      return {
        events: rows.map((e) => ({
          id: e.id,
          title: e.title,
          category: e.category,
          startsAt: e.starts_at,
          endsAt: e.ends_at,
          locality: e.locality,
          localityLabel: e.locality_label,
          venueId: e.venue_id,
          locationName: e.location_name,
          interestedCount: e.interested_count,
          distanceM: e.distance_m,
          viewerInterested: interested.has(e.id),
        })),
      };
    }),

  /** Public: one event with author/venue embeds and the caller's "interested" state. Null when missing. */
  byId: publicProcedure
    .input(z.object({ eventId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("events")
        .select(EVENT_COLS)
        .eq("id", input.eventId)
        .maybeSingle()) as PgResult<RawEvent | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load this event: ${error.message}` });
      }
      if (!data) return null;
      const interested = await viewerInterest(db, [data.id]);
      return shapeEvent(data, interested.has(data.id));
    }),

  /** Protected: post an event on the locality you're browsing. Needs a venue OR a place name. */
  create: protectedProcedure
    .input(
      z.object({
        localityName: z.string().trim().min(1).max(120),
        title,
        description: description.optional(),
        category: categorySchema.optional(),
        startsAt: isoDate,
        endsAt: isoDate.optional(),
        venueId: z.string().uuid().optional(),
        locationName: locationName.optional(),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
        url: z.string().url().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const author_id = await callerId(db);
      if (!eventHasPlace(input.venueId, input.locationName)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "An event needs a venue or a place name." });
      }
      if (endsBeforeStarts(input.startsAt, input.endsAt)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The end time can't be before the start time." });
      }
      let locality: string;
      let locality_label: string;
      try {
        locality = localitySlug(input.localityName);
        locality_label = localityLabel(input.localityName);
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : "Invalid locality." });
      }
      const { data, error } = (await db
        .from("events")
        .insert({
          author_id,
          locality,
          locality_label,
          title: input.title,
          description: orNull(input.description),
          category: input.category ?? null,
          starts_at: input.startsAt,
          ends_at: input.endsAt ?? null,
          venue_id: input.venueId ?? null,
          location_name: orNull(input.locationName),
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          url: orNull(input.url),
        })
        .select("id")
        .single()) as PgResult<{ id: string } | null>;
      if (error || !data) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't post your event. Please try again." });
      }
      return { id: data.id };
    }),

  /** Protected: edit your own event (RLS enforces ownership). Only the passed fields change. */
  update: protectedProcedure
    .input(
      z.object({
        eventId: z.string().uuid(),
        title: title.optional(),
        description: description.optional(),
        category: categorySchema.nullable().optional(),
        startsAt: isoDate.optional(),
        endsAt: isoDate.nullable().optional(),
        venueId: z.string().uuid().nullable().optional(),
        locationName: locationName.nullable().optional(),
        lat: z.number().min(-90).max(90).nullable().optional(),
        lng: z.number().min(-180).max(180).nullable().optional(),
        url: z.string().url().max(2000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.description !== undefined) patch.description = orNull(input.description);
      if (input.category !== undefined) patch.category = input.category;
      if (input.startsAt !== undefined) patch.starts_at = input.startsAt;
      if (input.endsAt !== undefined) patch.ends_at = input.endsAt;
      if (input.venueId !== undefined) patch.venue_id = input.venueId;
      if (input.locationName !== undefined) patch.location_name = input.locationName ? input.locationName.trim() : null;
      if (input.lat !== undefined) patch.lat = input.lat;
      if (input.lng !== undefined) patch.lng = input.lng;
      if (input.url !== undefined) patch.url = input.url ? input.url.trim() : null;
      if (Object.keys(patch).length === 0) return { id: input.eventId };
      const { data, error } = (await db
        .from("events")
        .update(patch)
        .eq("id", input.eventId)
        .select("id")
        .maybeSingle()) as PgResult<{ id: string } | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't save your changes. Please try again." });
      }
      if (!data) throw new TRPCError({ code: "FORBIDDEN", message: "You can only edit your own event." });
      return { id: data.id };
    }),

  /** Protected: mark your own event cancelled (it stays visible, clearly flagged). */
  cancel: protectedProcedure
    .input(z.object({ eventId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      const { data, error } = (await db
        .from("events")
        .update({ status: "cancelled" })
        .eq("id", input.eventId)
        .select("id")
        .maybeSingle()) as PgResult<{ id: string } | null>;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't cancel the event." });
      if (!data) throw new TRPCError({ code: "FORBIDDEN", message: "You can only cancel your own event." });
      return { id: data.id };
    }),

  /** Protected: delete your own event. */
  remove: protectedProcedure
    .input(z.object({ eventId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      const { error } = (await db.from("events").delete().eq("id", input.eventId)) as PgResult<null>;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't delete the event." });
      return { ok: true };
    }),

  /** Protected: add/remove your "interested" mark. Returns the new state + trigger-maintained count. */
  toggleInterest: protectedProcedure
    .input(z.object({ eventId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const user_id = await callerId(db);
      const { data: existing } = (await db
        .from("event_interest")
        .select("event_id")
        .eq("event_id", input.eventId)
        .eq("user_id", user_id)
        .maybeSingle()) as PgResult<{ event_id: string } | null>;
      let interested: boolean;
      if (existing) {
        const { error } = (await db
          .from("event_interest")
          .delete()
          .eq("event_id", input.eventId)
          .eq("user_id", user_id)) as PgResult<null>;
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't update your interest." });
        interested = false;
      } else {
        const { error } = (await db
          .from("event_interest")
          .insert({ event_id: input.eventId, user_id })) as PgResult<null>;
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't update your interest." });
        interested = true;
      }
      const { data: ev } = (await db
        .from("events")
        .select("interested_count")
        .eq("id", input.eventId)
        .maybeSingle()) as PgResult<{ interested_count: number } | null>;
      return { interested, interestedCount: ev?.interested_count ?? 0 };
    }),

  /** Protected: the events you created, newest-first. */
  mine: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const author_id = await callerId(db);
      const { data, error } = (await db
        .from("events")
        .select(EVENT_COLS)
        .eq("author_id", author_id)
        .order("starts_at", { ascending: false })
        .limit(input.limit)) as PgResult<RawEvent[] | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load your events: ${error.message}` });
      }
      const rows = data ?? [];
      const interested = await viewerInterest(db, rows.map((r) => r.id));
      return { events: rows.map((e) => shapeEvent(e, interested.has(e.id))) };
    }),

  /** Protected: report an event — files a user_report into moderation_queue (report-then-act). */
  reportEvent: protectedProcedure
    .input(z.object({ eventId: z.string().uuid(), detail: z.string().trim().max(1000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const reporterId = await callerId(db);
      const { error } = (await db.from("moderation_queue").insert({
        entity_type: "event",
        entity_id: input.eventId,
        reason: "user_report",
        reporter_id: reporterId,
        detail: input.detail ?? null,
      })) as PgResult<null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't submit your report. Please try again." });
      }
      return { ok: true };
    }),
});
