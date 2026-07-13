/**
 * Profiles router — the signed-in user's own account.
 *
 * Two procedures, both protected (they act as the caller on their OWN row):
 *   - me      : read the caller's profile (creating the read-through default if the
 *               auto-provision trigger hasn't run yet is unnecessary — handle_new_auth_user
 *               makes the row at signup; we just read it).
 *   - updateMe: write the editable columns (display_name, handle, bio, avatar/header url,
 *               social_links). RLS (profiles_update: id = auth.uid()) is the real gate; the
 *               column gate here is the pure profile-details normalization, so the client
 *               can't write a malformed handle or a non-http link.
 *
 * Uniqueness: profiles.handle is UNIQUE — a clash surfaces as Postgres 23505, which we map
 * to a friendly CONFLICT rather than a 500.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure, escalateToService } from "../trpc.js";
import {
  normaliseDisplayName,
  normaliseHandle,
  normaliseBio,
  normaliseImageUrl,
  normaliseProfileLinks,
} from "../profile-details.js";

/** The profile row we read/return. profiles is in the generated DB types, but we keep the
 *  read loose-typed for the columns we surface to stay resilient to type regen drift. */
interface ProfileRow {
  id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  header_url: string | null;
  bio: string | null;
  social_links: Record<string, unknown> | null;
}

/** Pull a single displayable website URL out of the free-form social_links bag (a "website"/"url"
 *  key first, else the first http(s) value). Returns null when there's nothing usable. */
function firstWebsite(links: unknown): string | null {
  if (!links || typeof links !== "object") return null;
  const bag = links as Record<string, unknown>;
  const isHttp = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//i.test(v.trim());
  for (const key of ["website", "url", "site", "web", "homepage"]) {
    if (isHttp(bag[key])) return (bag[key] as string).trim();
  }
  for (const v of Object.values(bag)) if (isHttp(v)) return v.trim();
  return null;
}

/**
 * A client Place as stored in profiles.place_prefs — the web PlaceSwitcher's shape, kept in
 * lockstep by contract (the client owns the shape; the API bounds and echoes it). `hint` is
 * the menu sublabel; `source` is selection provenance (drives the anon discovery meter).
 */
const placeSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(160),
  hint: z.string().max(160).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  source: z.enum(["search", "current", "suggested", "saved", "default"]).optional(),
});
export interface StoredPlace {
  id: string;
  name: string;
  hint?: string;
  lat: number;
  lng: number;
  source?: "search" | "current" | "suggested" | "saved" | "default";
}

async function currentUserId(ctx: { db: { auth: { getUser: () => Promise<{ data: { user: { id: string } | null }; error: unknown }> } } }): Promise<string> {
  const { data, error } = await ctx.db.auth.getUser();
  if (error || !data.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Could not resolve the signed-in user." });
  }
  return data.user.id;
}

export const profilesRouter = router({
  /**
   * Public: read another user's public profile by id (for their wall header etc.).
   * profiles_read RLS is `using (true)`, so this surfaces only the public-facing columns —
   * the same fields shown wherever a user appears. Returns null if no such profile.
   *
   * Wall views is the one OWNER-ONLY field here: it's a private insight (how many people viewed
   * your wall), so the count is included in the response only when the caller IS the profile's
   * owner. Every other viewer — signed-in or anonymous — never receives the number at all.
   */
  byId: publicProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      type LooseProfileRead = {
        from: (t: string) => {
          select: (c: string) => {
            eq: (col: string, val: string) => {
              maybeSingle: () => Promise<{ data: ProfileRow | null; error: { message: string } | null }>;
            };
          };
        };
      };
      const db = ctx.db as unknown as LooseProfileRead;
      const { data, error } = await db
        .from("profiles")
        .select("id, handle, display_name, avatar_url, header_url, bio, social_links, created_at, home_locality, verified_local, wall_view_count")
        .eq("id", input.userId)
        .maybeSingle();
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load profile: ${error.message}` });
      }
      if (!data) return null;
      // Resolve the caller (best-effort; anonymous stays null) to gate the owner-only wall-view count.
      let viewerId: string | null = null;
      try {
        const { data: u } = await ctx.db.auth.getUser();
        viewerId = u.user?.id ?? null;
      } catch {
        viewerId = null;
      }
      const isOwner = viewerId != null && viewerId === data.id;
      return {
        id: data.id,
        handle: data.handle ?? null,
        displayName: data.display_name ?? null,
        avatarUrl: data.avatar_url ?? null,
        headerUrl: data.header_url ?? null,
        bio: data.bio ?? null,
        // When the profile joined (for the "Joined {month year}" facts) + the website from their
        // social links (About card). Both already stored; just surfaced now for the profile redesign.
        joinedAt: (data as { created_at?: string | null }).created_at ?? null,
        website: firstWebsite((data as { social_links?: unknown }).social_links),
        homeLocality: (data as { home_locality?: string | null }).home_locality ?? null,
        verifiedLocal: (data as { verified_local?: boolean | null }).verified_local ?? false,
        // Owner-only: absent from the payload for every other viewer (privacy, not just UI hiding).
        wallViews: isOwner ? ((data as { wall_view_count?: number | null }).wall_view_count ?? 0) : null,
      };
    }),

  /** Public, fire-and-forget: count a profile view (record_profile_view; no viewer identity
   *  stored). The wall page calls this once per profile per session. Never throws into the page. */
  recordView: publicProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }> };
      const { error } = await db.rpc("record_profile_view", { p_profile: input.userId });
      return { ok: !error };
    }),

  /**
   * Public: search people by display name or @handle (Instagram/LinkedIn-style find-and-connect).
   * Case-insensitive substring match on either field (pg_trgm-accelerated, migration 0040).
   * profiles_read RLS is `using (true)`, so this is a public discovery surface; we surface only
   * the public card fields. A blank/short query returns nothing (no "list everyone"). The caller,
   * when signed in, is excluded from results (you don't friend/message yourself).
   */
  search: publicProcedure
    .input(z.object({ q: z.string().trim().min(2).max(80), limit: z.number().int().min(1).max(30).default(20) }))
    .query(async ({ ctx, input }) => {
      // Escape PostgREST/ILIKE wildcards in the user's query so they're treated literally.
      const term = input.q.replace(/[%,()\\]/g, " ").trim();
      if (term.length < 2) return { people: [] };

      // Resolve the caller (if any) to exclude self — best-effort; anon search still works.
      let me: string | null = null;
      try {
        const { data } = await ctx.db.auth.getUser();
        me = data.user?.id ?? null;
      } catch {
        me = null;
      }

      type Row = { id: string; handle: string | null; display_name: string | null; avatar_url: string | null; bio: string | null };
      type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      const db = ctx.db as unknown as Loose;
      const { data, error } = (await db
        .from("profiles")
        .select("id, handle, display_name, avatar_url, bio")
        .or(`display_name.ilike.%${term}%,handle.ilike.%${term}%`)
        .limit(input.limit + 1)) as { data: Row[] | null; error: { message: string } | null };
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Search failed: ${error.message}` });
      }
      const people = (data ?? [])
        .filter((r) => r.id !== me)
        .slice(0, input.limit)
        .map((r) => ({
          id: r.id,
          handle: r.handle ?? null,
          displayName: r.display_name ?? null,
          avatarUrl: r.avatar_url ?? null,
          bio: r.bio ?? null,
        }));
      return { people };
    }),

  /**
   * Public: read a profile by its @handle — the canonical, username-based lookup behind
   * /u/{handle}. Input is cleaned leniently (strip a leading @, lower-case); a malformed or
   * unknown handle simply resolves to null (not an error), the same posture as byId.
   */
  byHandle: publicProcedure
    .input(z.object({ handle: z.string().trim().min(1).max(60) }))
    .query(async ({ ctx, input }) => {
      const handle = input.handle.replace(/^@/, "").trim().toLowerCase();
      if (!/^[a-z0-9_]{3,30}$/.test(handle)) return null;
      type LooseProfileRead = {
        from: (t: string) => {
          select: (c: string) => {
            eq: (col: string, val: string) => {
              maybeSingle: () => Promise<{ data: ProfileRow | null; error: { message: string } | null }>;
            };
          };
        };
      };
      const db = ctx.db as unknown as LooseProfileRead;
      const { data, error } = await db
        .from("profiles")
        .select("id, handle, display_name, avatar_url, header_url, bio, social_links")
        .eq("handle", handle)
        .maybeSingle();
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load profile: ${error.message}` });
      }
      if (!data) return null;
      return {
        id: data.id,
        handle: data.handle ?? null,
        displayName: data.display_name ?? null,
        avatarUrl: data.avatar_url ?? null,
        headerUrl: data.header_url ?? null,
        bio: data.bio ?? null,
      };
    }),

  /**
   * Public: is a handle valid and free? Powers the live availability check in the profile editor.
   * Returns the normalised handle plus availability; an invalid format comes back available:false
   * with a reason. The signed-in caller's OWN current handle counts as available (so editing your
   * other fields doesn't report your own handle as taken).
   */
  checkHandle: publicProcedure
    .input(z.object({ handle: z.string().max(60) }))
    .query(async ({ ctx, input }) => {
      let normalized: string | null;
      try {
        normalized = normaliseHandle(input.handle);
      } catch (e) {
        return { available: false as const, normalized: null, reason: e instanceof Error ? e.message : "Invalid handle." };
      }
      if (!normalized) {
        return { available: false as const, normalized: null, reason: "Choose a handle." };
      }
      // Resolve the caller (if any) so their own handle reads as available.
      let me: string | null = null;
      try {
        const { data } = await ctx.db.auth.getUser();
        me = data.user?.id ?? null;
      } catch {
        me = null;
      }
      type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      const db = ctx.db as unknown as Loose;
      const { data, error } = (await db
        .from("profiles")
        .select("id")
        .eq("handle", normalized)
        .maybeSingle()) as { data: { id: string } | null; error: { message: string } | null };
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't check that handle: ${error.message}` });
      }
      const taken = !!data && data.id !== me;
      return taken
        ? { available: false as const, normalized, reason: "That handle is already taken." }
        : { available: true as const, normalized };
    }),

  /** Protected: read the caller's own profile. */
  me: protectedProcedure.query(async ({ ctx }) => {
    const uid = await currentUserId(ctx);
    type LooseProfileRead = {
      from: (t: string) => {
        select: (c: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => Promise<{ data: ProfileRow | null; error: { message: string } | null }>;
          };
        };
      };
    };
    const db = ctx.db as unknown as LooseProfileRead;
    const { data, error } = await db
      .from("profiles")
      .select("id, handle, display_name, avatar_url, header_url, bio, social_links, home_locality")
      .eq("id", uid)
      .maybeSingle();
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load your profile: ${error.message}` });
    }
    // Build an inline-typed result (anonymous structural — no named-type leak into AppRouter).
    return {
      homeLocality: (data as { home_locality?: string | null } | null)?.home_locality ?? null,
      id: uid,
      handle: data?.handle ?? null,
      displayName: data?.display_name ?? null,
      avatarUrl: data?.avatar_url ?? null,
      headerUrl: data?.header_url ?? null,
      bio: data?.bio ?? null,
      socialLinks: (data?.social_links ?? {}) as Record<string, string>,
    };
  }),

  /** Protected: update the caller's editable profile columns. */
  updateMe: protectedProcedure
    .input(
      z.object({
        displayName: z.string().max(200).nullable().optional(),
        handle: z.string().max(60).nullable().optional(),
        bio: z.string().max(5000).nullable().optional(),
        avatarUrl: z.string().max(4096).nullable().optional(),
        headerUrl: z.string().max(4096).nullable().optional(),
        socialLinks: z.record(z.unknown()).nullable().optional(),
        homeLocality: z.string().max(120).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const uid = await currentUserId(ctx);

      // Column gate: normalise only the fields the client actually sent (a partial update).
      const patch: Record<string, unknown> = {};
      try {
        if ("displayName" in input) patch["display_name"] = normaliseDisplayName(input.displayName);
        if ("handle" in input) {
          const h = normaliseHandle(input.handle);
          // A handle is required (it's the user's canonical URL) — refuse to clear it to null.
          if (!h) throw new RangeError("Choose a handle — it's your profile's web address.");
          patch["handle"] = h;
        }
        if ("bio" in input) patch["bio"] = normaliseBio(input.bio);
        if ("homeLocality" in input) patch["home_locality"] = input.homeLocality?.trim() || null;
        if ("avatarUrl" in input) patch["avatar_url"] = normaliseImageUrl(input.avatarUrl);
        if ("headerUrl" in input) patch["header_url"] = normaliseImageUrl(input.headerUrl);
        if ("socialLinks" in input) {
          // social_links is NOT NULL default '{}' (0001) — clearing writes {}, not null.
          patch["social_links"] = normaliseProfileLinks(input.socialLinks) ?? {};
        }
      } catch (e) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: e instanceof Error ? e.message : "Invalid profile details.",
        });
      }

      if (Object.keys(patch).length === 0) return { ok: true as const };

      type LooseProfileUpdate = {
        from: (t: string) => {
          update: (p: Record<string, unknown>) => {
            eq: (col: string, val: string) => {
              select: (c: string) => Promise<{
                data: { id: string }[] | null;
                error: { message: string; code?: string } | null;
              }>;
            };
          };
        };
      };
      const db = ctx.db as unknown as LooseProfileUpdate;
      const { data, error } = await db.from("profiles").update(patch).eq("id", uid).select("id");

      if (error) {
        // 23505 = unique_violation → the handle is taken.
        if (error.code === "23505") {
          throw new TRPCError({ code: "CONFLICT", message: "That handle is already taken." });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to update your profile: ${error.message}`,
        });
      }
      // RLS silently returns zero rows if the update wasn't permitted (shouldn't happen for self).
      if (!data || data.length === 0) return { ok: false as const };
      return { ok: true as const };
    }),

  /**
   * Protected: read the caller's saved Home dashboard layout (cross-device personalisation).
   * Returns { layout: { order, hidden } } or { layout: null } when they've never customised it.
   * Validated leniently — a malformed stored value reads as null so the client uses its default.
   */
  homeLayout: protectedProcedure.query(async ({ ctx }) => {
    const uid = await currentUserId(ctx);
    type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const db = ctx.db as unknown as Loose;
    const { data, error } = (await db
      .from("profiles")
      .select("home_layout")
      .eq("id", uid)
      .maybeSingle()) as { data: { home_layout: unknown } | null; error: { message: string } | null };
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load your layout: ${error.message}` });
    }
    const raw = data?.home_layout as { order?: unknown; hidden?: unknown } | null | undefined;
    const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
    const layout: { order: string[]; hidden: string[] } | null =
      raw && typeof raw === "object" && isStrArr(raw.order) && isStrArr(raw.hidden)
        ? { order: raw.order.slice(0, 64), hidden: raw.hidden.slice(0, 64) }
        : null;
    return { layout };
  }),

  /**
   * Protected: save the caller's Home dashboard layout. Bounded arrays of opaque widget ids; the
   * server stores them verbatim (RLS profiles_update gates the write to the caller's own row).
   */
  setHomeLayout: protectedProcedure
    .input(
      z.object({
        order: z.array(z.string().max(64)).max(64),
        hidden: z.array(z.string().max(64)).max(64),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const uid = await currentUserId(ctx);
      const payload = { order: input.order, hidden: input.hidden };
      type LooseUpdate = {
        from: (t: string) => {
          update: (p: Record<string, unknown>) => {
            eq: (col: string, val: string) => {
              select: (c: string) => Promise<{ data: { id: string }[] | null; error: { message: string } | null }>;
            };
          };
        };
      };
      const db = ctx.db as unknown as LooseUpdate;
      const { data, error } = await db.from("profiles").update({ home_layout: payload }).eq("id", uid).select("id");
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to save your layout: ${error.message}` });
      }
      return { ok: !!data && data.length > 0 };
    }),

  /**
   * Protected: read the caller's saved place preferences (cross-device sync of the pinned
   * places + the last active browsing place). Returns { prefs: { saved, last } } or
   * { prefs: null } when they've never synced. Validated leniently — a malformed stored
   * value (or malformed entries within it) reads as null/dropped so the client falls back
   * to its local state.
   */
  placePrefs: protectedProcedure.query(async ({ ctx }) => {
    const uid = await currentUserId(ctx);
    type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const db = ctx.db as unknown as Loose;
    const { data, error } = (await db
      .from("profiles")
      .select("place_prefs")
      .eq("id", uid)
      .maybeSingle()) as { data: { place_prefs: unknown } | null; error: { message: string } | null };
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load your places: ${error.message}` });
    }
    const raw = data?.place_prefs as { saved?: unknown; last?: unknown } | null | undefined;
    const isPlace = (v: unknown): v is StoredPlace => {
      const p = v as StoredPlace | null;
      return (
        !!p &&
        typeof p === "object" &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        typeof p.lat === "number" &&
        typeof p.lng === "number"
      );
    };
    const prefs: { saved: StoredPlace[]; last: StoredPlace | null } | null =
      raw && typeof raw === "object" && Array.isArray(raw.saved)
        ? { saved: raw.saved.filter(isPlace).slice(0, 24), last: isPlace(raw.last) ? raw.last : null }
        : null;
    return { prefs };
  }),

  /**
   * Protected: save the caller's place preferences. Bounded, shape-validated Places; the
   * server stores them verbatim (RLS profiles_update gates the write to the caller's own row).
   */
  setPlacePrefs: protectedProcedure
    .input(
      z.object({
        saved: z.array(placeSchema).max(24),
        last: placeSchema.nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const uid = await currentUserId(ctx);
      const payload = { saved: input.saved, last: input.last };
      type LooseUpdate = {
        from: (t: string) => {
          update: (p: Record<string, unknown>) => {
            eq: (col: string, val: string) => {
              select: (c: string) => Promise<{ data: { id: string }[] | null; error: { message: string } | null }>;
            };
          };
        };
      };
      const db = ctx.db as unknown as LooseUpdate;
      const { data, error } = await db.from("profiles").update({ place_prefs: payload }).eq("id", uid).select("id");
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to save your places: ${error.message}` });
      }
      return { ok: !!data && data.length > 0 };
    }),

  /**
   * Protected: permanently delete the caller's OWN account (GDPR "right to erasure").
   *
   * The user id comes from the VERIFIED session — a caller can only ever delete themselves, never
   * another account (no id is taken from input). We escalate to the service client (the sanctioned
   * in-process pattern, same as posts.create) purely to reach the auth admin API: deleting the
   * auth.users row cascades through `on delete cascade` FKs — profiles → the user's posts, plans,
   * follows, friendships, chat memberships, votes, saved offers, notifications, push tokens, venue
   * claims and town-hall contributions. (Comments they left keep their text with author set null,
   * so threads don't gap.) Storage objects (avatar/header) aren't FK-cascaded and are left for a
   * later sweep. Irreversible — the client gates this behind a typed confirmation.
   */
  deleteMe: protectedProcedure.mutation(async ({ ctx }) => {
    const uid = await currentUserId(ctx);
    const service = escalateToService(ctx.env);
    const admin = service.auth.admin as unknown as {
      deleteUser: (id: string) => Promise<{ error: { message: string } | null }>;
    };
    const { error } = await admin.deleteUser(uid);
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to delete your account: ${error.message}` });
    }
    return { ok: true as const };
  }),

  /**
   * Protected: read the caller's PRIVATE data (birth date + birthday-offer opt-in). Lives in
   * user_private (owner-only RLS), never on the world-readable profiles row. Returns nulls/false
   * when the user hasn't set anything.
   */
  personal: protectedProcedure.query(async ({ ctx }) => {
    const uid = await currentUserId(ctx);
    type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const db = ctx.db as unknown as Loose;
    const { data, error } = (await db
      .from("user_private")
      .select("birth_date, birthday_offers_enabled")
      .eq("user_id", uid)
      .maybeSingle()) as { data: { birth_date: string | null; birthday_offers_enabled: boolean } | null; error: { message: string } | null };
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load your details: ${error.message}` });
    }
    return {
      birthDate: data?.birth_date ?? null,
      birthdayOffersEnabled: data?.birthday_offers_enabled ?? false,
    };
  }),

  /**
   * Protected: upsert the caller's private data. birthDate is validated to a plausible past date
   * (age 13–120); pass null to clear it. Owner-only via RLS on user_private.
   */
  setPersonal: protectedProcedure
    .input(
      z.object({
        birthDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")
          .nullable()
          .optional(),
        birthdayOffersEnabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const uid = await currentUserId(ctx);
      const patch: Record<string, unknown> = { user_id: uid };
      if ("birthDate" in input) {
        if (input.birthDate === null || input.birthDate === undefined) {
          patch["birth_date"] = null;
        } else {
          const age = ageInYears(input.birthDate);
          if (age === null || age < 13 || age > 120) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a valid date of birth." });
          }
          patch["birth_date"] = input.birthDate;
        }
      }
      if (input.birthdayOffersEnabled !== undefined) patch["birthday_offers_enabled"] = input.birthdayOffersEnabled;

      type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      const db = ctx.db as unknown as Loose;
      const { error } = await db.from("user_private").upsert(patch, { onConflict: "user_id" }).select("user_id");
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to save your details: ${(error as { message: string }).message}` });
      }
      return { ok: true as const };
    }),
});

/** Whole years between a YYYY-MM-DD date and today (UTC); null if unparseable or in the future. */
function ageInYears(iso: string): number | null {
  const then = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  const now = Date.now();
  if (then > now) return null;
  return Math.floor((now - then) / (365.2425 * 24 * 60 * 60 * 1000));
}
