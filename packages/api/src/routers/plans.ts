/**
 * Plans router — collaborative venue itineraries. A plan is a titled collection of venues
 * (optional notes + date, e.g. "Friday night out") that the OWNER and invited FRIENDS share,
 * and every plan has its own group chat. Surfaces: owner + venues (create/edit/add/remove),
 * membership (members/invite/removeMember), and the plan chat (chat → get_or_create_plan_thread).
 *
 * All procedures are protected and act as the caller under RLS (plans_*: owner manages; members
 * can add venues; reads gated to owner-or-member), EXCEPT `preview` — the public teaser a shared
 * plan link shows a non-member (counts only; see its comment). The plan_* tables aren't in the
 * generated DB types, so the client is loose-typed (same idiom as townHall); resolvers return
 * inline types.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure, escalateToService } from "../trpc.js";
import { normalisePlanTitle, normalisePlanNotes, normalisePlannedFor, PLAN_TITLE_MAX, PLAN_NOTES_MAX } from "../plan-details.js";

type PgResult<T> = { data: T; error: { message: string; code?: string } | null };
type LooseDb = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
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
}

export const plansRouter = router({
  /**
   * Protected: the caller's plans (owned or member-of), newest first, with the card facts:
   * venue count, "going" count (owner + accepted members), the first few member avatars for
   * the stack, and a locality (the first venue's) for the footer.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = ctx.db as unknown as LooseDb;
    await callerId(db);
    type Embed = { id: string; display_name: string | null; avatar_url: string | null };
    const one = (e: Embed | Embed[] | null | undefined): Embed | null =>
      Array.isArray(e) ? (e[0] ?? null) : (e ?? null);
    // RLS plans_read already scopes to owner-or-member. Plain select (no aggregate embed —
    // PostgREST count-embeds are finicky); the card facts are cheap batched lookups below.
    const { data, error } = (await db
      .from("plans")
      .select("id, owner_id, title, notes, planned_for, header_url, created_at, owner:profiles!plans_owner_id_fkey(id, display_name, avatar_url)")
      .order("created_at", { ascending: false })) as PgResult<
      {
        id: string;
        owner_id: string;
        title: string;
        notes: string | null;
        planned_for: string | null;
        header_url: string | null;
        created_at: string;
        owner: Embed | Embed[] | null;
      }[] | null
    >;
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load your plans: ${error.message}` });
    }
    const rows = data ?? [];
    const ids = rows.map((r) => r.id);

    // Venue count + first locality per plan (RLS scopes plan_venues to visible plans).
    // Two-step (no `venues(locality)` embed): the bare plan_venues→venues embed doesn't resolve
    // and, with its error ignored, silently under-counted every plan to 0. Plain selects.
    const counts = new Map<string, number>();
    const localities = new Map<string, string>();
    if (ids.length > 0) {
      const { data: pv, error: pvErr } = (await db
        .from("plan_venues")
        .select("plan_id, venue_id")
        .in("plan_id", ids)) as PgResult<{ plan_id: string; venue_id: string }[] | null>;
      if (pvErr) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load your plans: ${pvErr.message}` });
      }
      const pvRows = pv ?? [];
      const localityByVenue = new Map<string, string | null>();
      const venueIds = [...new Set(pvRows.map((r) => r.venue_id))];
      if (venueIds.length > 0) {
        const { data: vRows } = (await db
          .from("venues")
          .select("id, locality")
          .in("id", venueIds)) as PgResult<{ id: string; locality: string | null }[] | null>;
        for (const v of vRows ?? []) localityByVenue.set(v.id, v.locality);
      }
      for (const r of pvRows) {
        counts.set(r.plan_id, (counts.get(r.plan_id) ?? 0) + 1);
        const loc = localityByVenue.get(r.venue_id) ?? null;
        if (loc && !localities.has(r.plan_id)) localities.set(r.plan_id, loc);
      }
    }

    // Members per plan (for the avatar stack + going count). Owner is implicit, never a dupe.
    const membersByPlan = new Map<string, Embed[]>();
    if (ids.length > 0) {
      const { data: pm } = (await db
        .from("plan_members")
        .select("plan_id, profile_id, profiles(id, display_name, avatar_url)")
        .in("plan_id", ids)) as PgResult<
        { plan_id: string; profile_id: string; profiles: Embed | Embed[] | null }[] | null
      >;
      for (const m of pm ?? []) {
        const prof = one(m.profiles);
        if (!prof) continue;
        const list = membersByPlan.get(m.plan_id) ?? [];
        list.push(prof);
        membersByPlan.set(m.plan_id, list);
      }
    }

    return {
      plans: rows.map((p) => {
        const owner = one(p.owner);
        const invited = (membersByPlan.get(p.id) ?? []).filter((m) => m.id !== p.owner_id);
        const people = [...(owner ? [owner] : []), ...invited];
        return {
          id: p.id,
          title: p.title,
          notes: p.notes,
          plannedFor: p.planned_for,
          headerUrl: p.header_url,
          createdAt: p.created_at,
          venueCount: counts.get(p.id) ?? 0,
          locality: localities.get(p.id) ?? null,
          goingCount: people.length,
          memberAvatars: people.slice(0, 3).map((m) => ({
            id: m.id,
            displayName: m.display_name,
            avatarUrl: m.avatar_url,
          })),
        };
      }),
    };
  }),

  /**
   * Public: the TEASER a shared plan link shows a non-member — title, date, header image, and
   * member/venue COUNTS only. Deliberately excludes notes, venue names, member identities, and
   * chat. Reads via the sanctioned service escalation (plans RLS is member-scoped, so an anon
   * client sees nothing), with the column allowlist right here as the privacy boundary. A plan
   * id is an unguessable uuid — possession of the link is the capability, same as a chat invite.
   */
  preview: publicProcedure
    .input(z.object({ planId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const svc = escalateToService(ctx.env) as unknown as LooseDb;
      const { data: plan, error } = (await svc
        .from("plans")
        .select("id, title, planned_for, header_url")
        .eq("id", input.planId)
        .maybeSingle()) as PgResult<{ id: string; title: string; planned_for: string | null; header_url: string | null } | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load this plan: ${error.message}` });
      }
      if (!plan) return null;
      const [members, venues] = await Promise.all([
        svc.from("plan_members").select("plan_id", { count: "exact", head: true }).eq("plan_id", input.planId) as Promise<{ count: number | null }>,
        svc.from("plan_venues").select("plan_id", { count: "exact", head: true }).eq("plan_id", input.planId) as Promise<{ count: number | null }>,
      ]);
      return {
        id: plan.id,
        title: plan.title,
        plannedFor: plan.planned_for,
        headerUrl: plan.header_url,
        memberCount: members.count ?? 0,
        venueCount: venues.count ?? 0,
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
        .select("id, owner_id, title, notes, planned_for, header_url, created_at")
        .eq("id", input.planId)
        .maybeSingle()) as PgResult<{ id: string; owner_id: string; title: string; notes: string | null; planned_for: string | null; header_url: string | null; created_at: string } | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load this plan: ${error.message}` });
      }
      if (!plan) return null;

      // Two-step read, NOT a PostgREST embed. The bare `plan_venues → venues` embed did not
      // resolve, so the embedded select errored and — because the error was ignored — the plan
      // rendered "0 venues" even though the rows exist (confirmed in the DB). Plain selects can't
      // hit that failure; venues_read RLS is public so the venue facts read fine either way.
      const { data: pvRows, error: pvErr } = (await db
        .from("plan_venues")
        .select("venue_id, position")
        .eq("plan_id", input.planId)
        .order("position", { ascending: true })) as PgResult<{ venue_id: string; position: number }[] | null>;
      if (pvErr) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load this plan's venues: ${pvErr.message}` });
      }
      // Select ONLY real venue columns. `cover_photo_id` is NOT a stored column — it's a value
      // computed inside the venues_near/search RPCs (a subquery over venue_photos). Selecting it
      // here raised "column venues.cover_photo_id does not exist", which errored the whole read
      // (and is why the plan showed no venues). The plan venue card renders name + category only
      // (PlanVenue carries no cover), so there is nothing to compute — just drop the field.
      const pvList = pvRows ?? [];
      const venueById = new Map<string, EmbeddedVenue>();
      if (pvList.length > 0) {
        const { data: vRows, error: vErr } = (await db
          .from("venues")
          .select("id, name, category")
          .in("id", pvList.map((r) => r.venue_id))) as PgResult<EmbeddedVenue[] | null>;
        if (vErr) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load this plan's venues: ${vErr.message}` });
        }
        for (const v of vRows ?? []) venueById.set(v.id, v);
      }
      const venues = pvList.map((r) => {
        const v = venueById.get(r.venue_id);
        return {
          venueId: r.venue_id,
          name: v?.name ?? "Venue",
          category: v?.category ?? null,
        };
      });
      return {
        id: plan.id,
        title: plan.title,
        notes: plan.notes,
        plannedFor: plan.planned_for,
        headerUrl: plan.header_url,
        createdAt: plan.created_at,
        venues,
      };
    }),

  /**
   * Protected: venues to suggest adding to this plan — nearest to the centroid of the plan's
   * current venues, excluding ones already in it (plan_venue_suggestions, 0082). RLS gates it to
   * members (a non-member gets an empty anchor → no rows). Returns light cards for the strip.
   */
  suggestions: protectedProcedure
    .input(z.object({ planId: z.string().uuid(), limit: z.number().int().min(1).max(20).default(6) }))
    .query(async ({ ctx, input }) => {
      const rpc = ctx.db.rpc.bind(ctx.db) as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
      const { data, error } = await rpc("plan_venue_suggestions", {
        plan_id_param: input.planId,
        max_results: input.limit,
      });
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load suggestions: ${error.message}` });
      }
      const rows = (data ?? []) as {
        id: string;
        name: string;
        category: string | null;
        primary_type_label: string | null;
        rating: number | null;
      }[];
      return {
        venues: rows.map((r) => ({
          venueId: r.id,
          name: r.name,
          category: r.category,
          primaryTypeLabel: r.primary_type_label,
          rating: r.rating,
        })),
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
        // Custom banner image. A validated http(s) url (the uploaded object's public URL), or
        // null to clear back to the default gradient.
        headerUrl: z.string().url().max(2048).nullish(),
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
        if ("headerUrl" in input) patch["header_url"] = input.headerUrl ?? null;
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
      // ON CONFLICT DO NOTHING (ignoreDuplicates), NOT the default DO UPDATE: re-adding a venue
      // already in the plan must be a no-op. plan_venues has no UPDATE RLS policy (0037 grants
      // read/insert/delete only), so a DO UPDATE conflict path is refused by RLS ("new row
      // violates row-level security policy (USING expression)") — which broke every idempotent
      // re-add. DO NOTHING never takes the update path, so the intended idempotency just works.
      const { error } = (await db
        .from("plan_venues")
        .upsert(
          { plan_id: input.planId, venue_id: input.venueId, added_by },
          { onConflict: "plan_id,venue_id", ignoreDuplicates: true },
        )) as {
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

  /**
   * Protected: the plan's people — the owner plus invited members, each with their profile.
   * RLS (plan_members_read, plans_read) scopes both reads to plans the caller can see, so an
   * out-of-scope plan simply yields an empty list. role is 'owner' | 'member'.
   */
  members: protectedProcedure
    .input(z.object({ planId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      type Embed = { id: string; handle: string | null; display_name: string | null; avatar_url: string | null };
      const one = (e: Embed | Embed[] | null | undefined): Embed | null =>
        Array.isArray(e) ? (e[0] ?? null) : (e ?? null);

      // Owner (from plans, embedding their profile).
      const { data: plan } = (await db
        .from("plans")
        .select("owner_id, owner:profiles!plans_owner_id_fkey(id, handle, display_name, avatar_url)")
        .eq("id", input.planId)
        .maybeSingle()) as PgResult<{ owner_id: string; owner: Embed | Embed[] | null } | null>;
      if (!plan) return { members: [] };

      // Invited members.
      const { data: rows } = (await db
        .from("plan_members")
        .select("profile_id, accepted, profiles(id, handle, display_name, avatar_url)")
        .eq("plan_id", input.planId)) as PgResult<
        { profile_id: string; accepted: boolean; profiles: Embed | Embed[] | null }[] | null
      >;

      const shape = (e: Embed | null, id: string, role: "owner" | "member", accepted: boolean) => ({
        profileId: id,
        role,
        accepted,
        handle: e?.handle ?? null,
        displayName: e?.display_name ?? null,
        avatarUrl: e?.avatar_url ?? null,
      });

      const ownerProfile = one(plan.owner);
      const members = [shape(ownerProfile, plan.owner_id, "owner", true)];
      for (const r of rows ?? []) {
        if (r.profile_id === plan.owner_id) continue; // owner is implicit; never list twice
        members.push(shape(one(r.profiles), r.profile_id, "member", r.accepted));
      }
      return { members };
    }),

  /**
   * Protected: invite a friend onto the plan (owner only, via plan_members_write RLS). v1 adds
   * them directly (accepted=true) — a plan is a shared list among friends, not a request flow.
   * Idempotent on the (plan, profile) PK. If the plan's chat already exists the new member
   * self-joins it lazily the first time they open it (get_or_create_plan_thread).
   */
  invite: protectedProcedure
    .input(z.object({ planId: z.string().uuid(), profileId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      // ON CONFLICT DO NOTHING (ignoreDuplicates), same as addVenue: plan_members has no UPDATE
      // RLS policy (0037 grants read/insert/delete only), so a default DO UPDATE conflict path is
      // refused by RLS. Under the auto-accept model (invite writes accepted:true immediately)
      // re-inviting an existing member is a no-op, so DO NOTHING is exactly right.
      const { error } = (await db
        .from("plan_members")
        .upsert(
          { plan_id: input.planId, profile_id: input.profileId, accepted: true },
          { onConflict: "plan_id,profile_id", ignoreDuplicates: true },
        )) as { error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't add them to the plan." });
      return { ok: true as const };
    }),

  /** Protected: remove a member from the plan (owner or self, via plan_members_delete RLS). */
  removeMember: protectedProcedure
    .input(z.object({ planId: z.string().uuid(), profileId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      const { error } = (await db
        .from("plan_members")
        .delete()
        .eq("plan_id", input.planId)
        .eq("profile_id", input.profileId)) as { error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't remove that member." });
      return { ok: true as const };
    }),

  /**
   * Protected: open (get-or-create) the plan's group chat. Delegates to the
   * get_or_create_plan_thread RPC (migration 0035, SECURITY DEFINER): caller must be the plan
   * owner or a member, the thread is created once (seeded with owner + members) and reused
   * after. Returns the thread id so the client can route to /threads/[id].
   */
  chat: protectedProcedure
    .input(z.object({ planId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      const { data, error } = await db.rpc("get_or_create_plan_thread", { p_plan_id: input.planId });
      if (error) {
        if (error.code === "42501") {
          throw new TRPCError({ code: "FORBIDDEN", message: "You're not a member of this plan." });
        }
        if (error.code === "P0002") {
          throw new TRPCError({ code: "NOT_FOUND", message: "Plan not found." });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't open the plan chat." });
      }
      const thread = data as { id: string } | null;
      if (!thread?.id) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't open the plan chat." });
      }
      return { threadId: thread.id };
    }),
});
