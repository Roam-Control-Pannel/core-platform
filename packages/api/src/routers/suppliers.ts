/**
 * suppliers router — the F2G supplier marketplace over `orgs` (C3).
 *
 * Public directory reads (only live + approved orgs, the moderation hard gate) + member-gated
 * self-serve create + owner-only update. Authority is RLS: the orgs self-insert policy (0143) enforces
 * "live f2g member" via f2g_can_post_supplier and pins the safe shape (draft/pending/owner=self); the
 * owner-update column guard (0136) keeps status/moderation/slug server-managed. This router adds no
 * authority of its own — it maps an RLS rejection to a clean error and shapes the reads.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// orgs isn't in the generated DB types until regenerated (A1b).
const loose = (c: unknown) => c as { from: (t: string) => any; rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: any }> };

export interface SupplierOrg {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  website: string | null;
  locality: string | null;
  logoUrl: string | null;
  links: { label: string; url: string }[];
  createdAt: string;
}

export interface SupplierPage {
  orgs: SupplierOrg[];
  hasMore: boolean;
  nextOffset: number;
}

const linkSchema = z.object({ label: z.string().trim().min(1).max(60), url: z.string().url().max(2000) });

function toSupplier(r: any): SupplierOrg {
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    slug: String(r.slug ?? ""),
    description: r.description ?? null,
    category: String(r.category ?? "supplier"),
    website: r.website ?? null,
    locality: r.locality ?? null,
    logoUrl: r.logo_url ?? null,
    links: Array.isArray(r.links) ? (r.links as { label: string; url: string }[]) : [],
    createdAt: String(r.created_at ?? ""),
  };
}

const SELECT = "id, name, slug, description, category, website, locality, logo_url, links, created_at";

export const suppliersRouter = router({
  /** The public supplier directory: live + approved orgs, newest first (the moderation hard gate). */
  list: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(25), offset: z.number().int().min(0).default(0) }))
    .query(async ({ ctx, input }): Promise<SupplierPage> => {
      const { data, error } = await loose(ctx.db)
        .from("orgs")
        .select(SELECT)
        .eq("status", "live")
        .in("moderation", ["auto_approved", "approved"])
        .order("created_at", { ascending: false })
        .range(input.offset, input.offset + input.limit); // limit+1 → hasMore
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      const raw = (data ?? []) as any[];
      const hasMore = raw.length > input.limit;
      const page = hasMore ? raw.slice(0, input.limit) : raw;
      return { orgs: page.map(toSupplier), hasMore, nextOffset: input.offset + page.length };
    }),

  /** One supplier by slug — live+approved for the public, or the caller's own at any status (RLS). */
  bySlug: publicProcedure
    .input(z.object({ slug: z.string().min(1).max(120) }))
    .query(async ({ ctx, input }): Promise<SupplierOrg | null> => {
      const { data, error } = await loose(ctx.db).from("orgs").select(SELECT).eq("slug", input.slug).maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data ? toSupplier(data) : null;
    }),

  /** Whether the signed-in user may create a supplier (a live f2g member) — the composer pre-flight. */
  canPost: protectedProcedure.query(async ({ ctx }) => {
    const { data, error } = await loose(ctx.db).rpc("f2g_can_post_supplier");
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
    return { canPost: data === true };
  }),

  /**
   * Self-serve create. Entitlement + safe shape are enforced by the orgs self-insert RLS policy +
   * guard (0143): the row is forced draft/pending/owner=self regardless of payload, and a non-member
   * is rejected (mapped to FORBIDDEN). Only presentational fields are accepted here.
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(2).max(200),
        description: z.string().trim().max(4000).optional(),
        category: z.string().trim().max(60).optional(),
        website: z.string().url().max(2000).optional(),
        locality: z.string().trim().max(120).optional(),
        logoUrl: z.string().url().max(2000).optional(),
        links: z.array(linkSchema).max(12).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: auth } = await ctx.db.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to add your business." });
      const { data, error } = await loose(ctx.db)
        .from("orgs")
        .insert({
          owner_id: uid, // the guard pins this too; sent so WITH CHECK passes cleanly
          name: input.name,
          description: input.description ?? null,
          category: input.category ?? "supplier",
          website: input.website ?? null,
          locality: input.locality ?? null,
          logo_url: input.logoUrl ?? null,
          links: input.links ?? [],
        })
        .select("id, slug")
        .maybeSingle();
      if (error) {
        const rls = /row-level security/i.test(error.message ?? "") || error.code === "42501";
        throw new TRPCError({
          code: rls ? "FORBIDDEN" : "BAD_REQUEST",
          message: rls ? "Only live Food to Go members can add a supplier." : (error.message ?? "Failed to create the supplier."),
        });
      }
      return { id: (data as any)?.id ?? null, slug: (data as any)?.slug ?? null };
    }),

  /**
   * Owner update — presentational fields only. RLS (orgs_owner_update) scopes it to the owner and the
   * column guard (0136) rejects any attempt to touch status/moderation/owner/slug/category.
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(2).max(200).optional(),
        description: z.string().trim().max(4000).nullable().optional(),
        website: z.string().url().max(2000).nullable().optional(),
        locality: z.string().trim().max(120).nullable().optional(),
        logoUrl: z.string().url().max(2000).nullable().optional(),
        links: z.array(linkSchema).max(12).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const patch: Record<string, unknown> = {};
      if ("name" in input && input.name !== undefined) patch.name = input.name;
      if ("description" in input) patch.description = input.description ?? null;
      if ("website" in input) patch.website = input.website ?? null;
      if ("locality" in input) patch.locality = input.locality ?? null;
      if ("logoUrl" in input) patch.logo_url = input.logoUrl ?? null;
      if ("links" in input && input.links !== undefined) patch.links = input.links;
      if (Object.keys(patch).length === 0) return { ok: true as const };
      const { error } = await loose(ctx.db).from("orgs").update(patch).eq("id", input.id);
      if (error) {
        const denied = /row-level security|42501/i.test(error.message ?? "") || error.code === "42501";
        throw new TRPCError({
          code: denied ? "FORBIDDEN" : "BAD_REQUEST",
          message: denied ? "You can only edit your own supplier's details." : (error.message ?? "Failed to update the supplier."),
        });
      }
      return { ok: true as const };
    }),
});
/* eslint-enable @typescript-eslint/no-explicit-any */
