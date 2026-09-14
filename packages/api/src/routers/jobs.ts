/**
 * jobs router — the F2G employability board (C4).
 *
 * Public LIST (the board) + member-gated CREATE / author-owned CLOSE, plus a canPost pre-flight for
 * the composer. Authority is RLS: the job_posts insert policy (0142) enforces "live member of the
 * channel" via f2g_can_post_as_member, so a non-member's create is rejected at the DB. v1 is
 * post-and-apply-out — apply_url is the only apply path and no applicant data is accepted.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { channels as coreChannels, jobs as coreJobs } from "@roam/core";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// job_posts isn't in the generated DB types until regenerated (A1b).
const loose = (c: unknown) => c as { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }> };

export interface JobPost {
  id: string;
  title: string;
  description: string | null;
  employmentType: string | null;
  locality: string;
  localityLabel: string;
  locationName: string | null;
  applyUrl: string;
  salaryText: string | null;
  startsAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  venue: { name: string; slug: string } | null;
}

export interface JobPostPage {
  posts: JobPost[];
  hasMore: boolean;
  nextOffset: number;
}

export const jobsRouter = router({
  /** The public board for a channel: published, approved, not-yet-expired posts, newest first. */
  list: publicProcedure
    .input(
      z.object({
        channelKey: z.string().min(1).max(32),
        limit: z.number().int().min(1).max(50).default(25),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }): Promise<JobPostPage> => {
      const channel = await coreChannels.getChannelByKey(ctx.db, input.channelKey);
      if (!channel) return { posts: [], hasMore: false, nextOffset: input.offset };
      const nowIso = new Date().toISOString();
      const { data, error } = await loose(ctx.db)
        .from("job_posts")
        .select(
          "id, title, description, employment_type, locality, locality_label, location_name, apply_url, salary_text, starts_at, expires_at, created_at, venue:venues(name, slug)",
        )
        .eq("channel_id", channel.id)
        .eq("status", "published")
        .in("moderation", ["auto_approved", "approved"])
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
        .order("created_at", { ascending: false })
        .range(input.offset, input.offset + input.limit); // limit+1 → hasMore
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      const raw = (data ?? []) as any[];
      const hasMore = raw.length > input.limit;
      const page = hasMore ? raw.slice(0, input.limit) : raw;
      return {
        posts: page.map((r) => {
          const v = Array.isArray(r.venue) ? r.venue[0] : r.venue;
          return {
            id: String(r.id),
            title: String(r.title ?? ""),
            description: r.description ?? null,
            employmentType: r.employment_type ?? null,
            locality: String(r.locality ?? ""),
            localityLabel: String(r.locality_label ?? ""),
            locationName: r.location_name ?? null,
            applyUrl: String(r.apply_url ?? ""),
            salaryText: r.salary_text ?? null,
            startsAt: r.starts_at ?? null,
            expiresAt: r.expires_at ?? null,
            createdAt: String(r.created_at ?? ""),
            venue: v ? { name: String(v.name ?? ""), slug: String(v.slug ?? "") } : null,
          };
        }),
        hasMore,
        nextOffset: input.offset + page.length,
      };
    }),

  /** Whether the signed-in user may post on this channel (a live member) — the composer pre-flight. */
  canPost: protectedProcedure
    .input(z.object({ channelKey: z.string().min(1).max(32) }))
    .query(async ({ ctx, input }) => {
      const channel = await coreChannels.getChannelByKey(ctx.db, input.channelKey);
      if (!channel) return { canPost: false };
      const { data, error } = await loose(ctx.db).rpc("f2g_can_post_as_member", { p_channel_id: channel.id });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return { canPost: data === true };
    }),

  /**
   * Post a job. Entitlement (live member) is enforced by the job_posts insert RLS policy; an RLS
   * rejection maps to a clean FORBIDDEN. apply_url must be a real http(s) link (the only apply path).
   */
  create: protectedProcedure
    .input(
      z.object({
        channelKey: z.string().min(1).max(32),
        title: z.string().trim().min(1).max(140),
        description: z.string().trim().max(8000).optional(),
        employmentType: z.string().trim().max(40).optional(),
        locality: z.string().trim().min(1).max(120),
        localityLabel: z.string().trim().min(1).max(120),
        venueId: z.string().uuid().optional(),
        locationName: z.string().trim().max(200).optional(),
        applyUrl: z.string().trim().min(1).max(2000),
        salaryText: z.string().trim().max(120).optional(),
        startsAt: z.string().datetime().optional(),
        expiresAt: z.string().datetime().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const channel = await coreChannels.getChannelByKey(ctx.db, input.channelKey);
      if (!channel || channel.isDefault) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Jobs are posted on a branded channel, not the default." });
      }
      const applyUrl = coreJobs.normaliseApplyUrl(input.applyUrl);
      if (!applyUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "A valid http(s) apply link is required." });
      if (input.employmentType && !coreJobs.isEmploymentType(input.employmentType)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown employment type." });
      }
      const { data: auth } = await ctx.db.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to post a job." });

      const { data, error } = await loose(ctx.db)
        .from("job_posts")
        .insert({
          author_id: uid,
          channel_id: channel.id,
          title: input.title,
          description: input.description ?? null,
          employment_type: input.employmentType ?? null,
          locality: input.locality,
          locality_label: input.localityLabel,
          venue_id: input.venueId ?? null,
          location_name: input.locationName ?? null,
          apply_url: applyUrl,
          salary_text: input.salaryText ?? null,
          starts_at: input.startsAt ?? null,
          expires_at: input.expiresAt ?? null,
        })
        .select("id")
        .maybeSingle();
      if (error) {
        const rls = /row-level security/i.test(error.message ?? "") || error.code === "42501";
        throw new TRPCError({
          code: rls ? "FORBIDDEN" : "BAD_REQUEST",
          message: rls ? "Only live Food to Go members can post jobs." : (error.message ?? "Failed to post the job."),
        });
      }
      return { id: (data as { id?: string } | null)?.id ?? null };
    }),

  /** Close the caller's own post (author-owned by RLS). Idempotent. */
  close: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await loose(ctx.db).from("job_posts").update({ status: "closed" }).eq("id", input.id);
      if (error) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
      return { ok: true as const };
    }),
});
/* eslint-enable @typescript-eslint/no-explicit-any */
