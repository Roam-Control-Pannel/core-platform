/**
 * Plans router — personal venue itineraries (v1). A plan is an owned collection of venues with
 * a title, optional notes, and an optional date ("Friday night out"). The schema (0002) already
 * supports members and a linked plan-chat; this v1 surfaces the OWNER + venues path. Group
 * invites / plan-chat / meet-up wiring land with the friends graph (a later slice).
 *
 * All procedures are protected and act as the caller under RLS (plans_*: owner manages; members
 * can add venues; reads gated to owner-or-member). The plan_* tables aren't in the generated DB
 * types, so the client is loose-typed (same idiom as townHall); resolvers return inline types.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc.js";
import { normalisePlanTitle, normalisePlanNotes, normalisePlannedFor, PLAN_TITLE_MAX, PLAN_NOTES_MAX } from "../plan-details.js";

type PgResult<T> = { data: T; error: { message: string; code?: string } | null };
type LooseDb = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  auth: { getUser: () => Promise<{ data: { user: { id: string } | null }; error: unknown }> };
};

async function callerId(db: LooseDb): Promise<string> {
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Could not resolve the signed-in user." });
  }
  return data.user.id;
}

interface EmbeddedVenue {
  id: string;
  name: string;
  category: string | null;
  cover_photo_id: string | null;
}

const PLAN_VENUE_COLS = "venue_id, position, venues(id, name, category, cover_photo_id)";

export const plansRouter = router({
  /** Protected: the caller's plans (owned or member-of), newest first, with a venue count. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = ctx.db as unknown as LooseDb;
    await callerId(db);
    // RLS plans_read already scopes to owner-or-member. Plain select (no aggregate embed —
    // PostgREST count-embeds are finicky); venue counts are a second, cheap lookup below.
    const { data, error } = (await db
      .from("plans")
      .select("id, title, notes, planned_for, created_at")
      .order("created_at", { ascending: false })) as PgResult<
      { id: string; title: string; notes: string | null; planned_for: string | null; created_at: string }[] | null
    >;
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load your plans: ${error.message}` });
    }
    const rows = data ?? [];

    // Venue counts: one query over the visible plans (RLS scopes plan_venues to those), tallied
    // in JS. Avoids the aggregate-embed; a plan with none simply has count 0.
    const counts = new Map<string, number>();
    if (rows.length > 0) {
      const { data: pv } = (await db
        .from("plan_venues")
        .select("plan_id")
        .in("plan_id", rows.map((r) => r.id))) as PgResult<{ plan_id: string }[] | null>;
      for (const v of pv ?? []) counts.set(v.plan_id, (counts.get(v.plan_id) ?? 0) + 1);
    }

    return {
      plans: rows.map((p) => ({
        id: p.id,
        title: p.title,
        notes: p.notes,
        plannedFor: p.planned_for,
        createdAt: p.created_at,
        venueCount: counts.get(p.id) ?? 0,
      })),
    };
  }),

  /** Protected: one plan with its venues (RLS gates to owner-or-member). Null if not visible. */
  byId: protectedProcedure
    .input(z.object({ planId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      const { data: plan, error } = (await db
        .from("plans")
        .select("id, owner_id, title, notes, planned_for, created_at")
        .eq("id", input.planId)
        .maybeSingle()) as PgResult<{ id: string; owner_id: string; title: string; notes: string | null; planned_for: string | null; created_at: string } | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load this plan: ${error.message}` });
      }
      if (!plan) return null;

      const { data: rows } = (await db
        .from("plan_venues")
        .select(PLAN_VENUE_COLS)
        .eq("plan_id", input.planId)
        .order("position", { ascending: true })) as PgResult<
        { venue_id: string; position: number; venues: EmbeddedVenue | EmbeddedVenue[] | null }[] | null
      >;
      const venues = (rows ?? []).map((r) => {
        const v = Array.isArray(r.venues) ? (r.venues[0] ?? null) : r.venues;
        return {
          venueId: r.venue_id,
          name: v?.name ?? "Venue",
          category: v?.category ?? null,
          coverPhotoId: v?.cover_photo_id ?? null,
        };
      });
      return {
        id: plan.id,
        title: plan.title,
        notes: plan.notes,
        plannedFor: plan.planned_for,
        createdAt: plan.created_at,
        venues,
      };
    }),

  /** Protected: create a plan owned by the caller. */
  create: protectedProcedure
    .input(
      z.object({
        title: z.string().min(1).max(PLAN_TITLE_MAX + 50),
        notes: z.string().max(PLAN_NOTES_MAX + 500).nullish(),
        plannedFor: z.string().max(40).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const owner_id = await callerId(db);
      let row: { title: string; notes: string | null; planned_for: string | null };
      try {
        row = {
          title: normalisePlanTitle(input.title),
          notes: normalisePlanNotes(input.notes ?? null),
          planned_for: normalisePlannedFor(input.plannedFor ?? null),
        };
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : "Invalid plan." });
      }
      const { data, error } = (await db
        .from("plans")
        .insert({ ...row, owner_id })
        .select("id")
        .single()) as PgResult<{ id: string } | null>;
      if (error || !data) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't create your plan. Please try again." });
      }
      return { id: data.id };
    }),

  /** Protected: edit a plan's title / notes / date (owner only, via RLS). */
  update: protectedProcedure
    .input(
      z.object({
        planId: z.string().uuid(),
        title: z.string().min(1).max(PLAN_TITLE_MAX + 50).optional(),
        notes: z.string().max(PLAN_NOTES_MAX + 500).nullish(),
        plannedFor: z.string().max(40).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      const patch: Record<string, unknown> = {};
      try {
        if (input.title !== undefined) patch["title"] = normalisePlanTitle(input.title);
        if ("notes" in input) patch["notes"] = normalisePlanNotes(input.notes ?? null);
        if ("plannedFor" in input) patch["planned_for"] = normalisePlannedFor(input.plannedFor ?? null);
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : "Invalid plan." });
      }
      if (Object.keys(patch).length === 0) return { ok: true as const };
      const { error } = (await db.from("plans").update(patch).eq("id", input.planId)) as { error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't update your plan." });
      return { ok: true as const };
    }),

  /** Protected: delete a plan (owner only, via RLS). */
  remove: protectedProcedure
    .input(z.object({ planId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      const { error } = (await db.from("plans").delete().eq("id", input.planId)) as { error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't delete your plan." });
      return { ok: true as const };
    }),

  /** Protected: add a venue to a plan (owner or member, via RLS). Idempotent on (plan,venue). */
  addVenue: protectedProcedure
    .input(z.object({ planId: z.string().uuid(), venueId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const added_by = await callerId(db);
      const { error } = (await db
        .from("plan_venues")
        .upsert({ plan_id: input.planId, venue_id: input.venueId, added_by }, { onConflict: "plan_id,venue_id" })) as {
        error: { message: string } | null;
      };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't add that to the plan." });
      return { ok: true as const };
    }),

  /** Protected: remove a venue from a plan (owner only, via RLS). */
  removeVenue: protectedProcedure
    .input(z.object({ planId: z.string().uuid(), venueId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      const { error } = (await db
        .from("plan_venues")
        .delete()
        .eq("plan_id", input.planId)
        .eq("venue_id", input.venueId)) as { error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't remove that from the plan." });
      return { ok: true as const };
    }),
});
