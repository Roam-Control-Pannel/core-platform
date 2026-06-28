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
import { router, protectedProcedure } from "../trpc.js";
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

async function currentUserId(ctx: { db: { auth: { getUser: () => Promise<{ data: { user: { id: string } | null }; error: unknown }> } } }): Promise<string> {
  const { data, error } = await ctx.db.auth.getUser();
  if (error || !data.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Could not resolve the signed-in user." });
  }
  return data.user.id;
}

export const profilesRouter = router({
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
      .select("id, handle, display_name, avatar_url, header_url, bio, social_links")
      .eq("id", uid)
      .maybeSingle();
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load your profile: ${error.message}` });
    }
    // Build an inline-typed result (anonymous structural — no named-type leak into AppRouter).
    return {
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
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const uid = await currentUserId(ctx);

      // Column gate: normalise only the fields the client actually sent (a partial update).
      const patch: Record<string, unknown> = {};
      try {
        if ("displayName" in input) patch["display_name"] = normaliseDisplayName(input.displayName);
        if ("handle" in input) patch["handle"] = normaliseHandle(input.handle);
        if ("bio" in input) patch["bio"] = normaliseBio(input.bio);
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
});
