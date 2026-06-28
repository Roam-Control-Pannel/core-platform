/**
 * Town Hall router — the per-locality public forum (0030_town_hall.sql).
 *
 * Reads are PUBLIC (browse a town's board signed-out, same posture as venues.near); writes are
 * PROTECTED and act as the caller on their own rows (RLS author_id = auth.uid() is the real gate).
 *
 *   listTopics  (public)    — a locality's topics, sorted by popular (upvotes) or recent.
 *   getTopic    (public)    — one topic + its replies.
 *   createTopic (protected) — start a topic on the locality you're browsing.
 *   createReply (protected) — reply to a topic.
 *   toggleUpvote(protected) — add/remove your single upvote; counts are trigger-maintained.
 *   reportTopic / reportReply (protected) — file a user_report into moderation_queue (0003),
 *                             the report-then-act backstop (same as moderation.reportVenue).
 *
 * The API owns the locality SLUG: the web sends the place NAME it's browsing and localitySlug()
 * derives the key here, so create and list always agree. Author identity is embedded live from
 * profiles via the FK. The town_hall_* tables aren't in the generated DB types, so the client is
 * loose-typed at each call (same idiom as moderation/profiles); every resolver returns an INLINE
 * structural object so no named type leaks into AppRouter (TS2883/4023).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";
import {
  localitySlug,
  localityLabel,
  normaliseTopicTitle,
  normaliseTopicBody,
  normaliseReplyBody,
  TOPIC_TITLE_MAX,
  TOPIC_BODY_MAX,
  REPLY_BODY_MAX,
} from "../town-hall.js";

/* ── loose client shapes (town_hall_* isn't in the generated DB types) ─────────────────── */

type PgResult<T> = { data: T; error: { message: string; code?: string } | null };
type LooseDb = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  auth: { getUser: () => Promise<{ data: { user: { id: string } | null }; error: unknown }> };
};

/** A profile embedded as a topic/reply author. Any field may be null (author deleted → set null). */
interface AuthorEmbed {
  id: string | null;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

/** The author embed select fragment, by the FK so PostgREST resolves it unambiguously. */
const TOPIC_AUTHOR = "author:profiles!town_hall_topics_author_id_fkey(id, handle, display_name, avatar_url)";
const REPLY_AUTHOR = "author:profiles!town_hall_replies_author_id_fkey(id, handle, display_name, avatar_url)";

const TOPIC_COLS = `id, locality, locality_label, title, body, upvote_count, reply_count, last_activity_at, created_at, ${TOPIC_AUTHOR}`;
const REPLY_COLS = `id, topic_id, body, created_at, ${REPLY_AUTHOR}`;

interface RawTopic {
  id: string;
  locality: string;
  locality_label: string;
  title: string;
  body: string;
  upvote_count: number;
  reply_count: number;
  last_activity_at: string;
  created_at: string;
  author: AuthorEmbed | AuthorEmbed[] | null;
}
interface RawReply {
  id: string;
  topic_id: string;
  body: string;
  created_at: string;
  author: AuthorEmbed | AuthorEmbed[] | null;
}

/** PostgREST returns an embed as an object for a to-one FK, but tolerate an array form too. */
function oneAuthor(a: AuthorEmbed | AuthorEmbed[] | null): AuthorEmbed | null {
  if (Array.isArray(a)) return a[0] ?? null;
  return a;
}

/** Shape an author into the inline public form: a best-effort display name, never PII beyond profile. */
function shapeAuthor(a: AuthorEmbed | AuthorEmbed[] | null) {
  const author = oneAuthor(a);
  return {
    id: author?.id ?? null,
    handle: author?.handle ?? null,
    displayName: author?.display_name ?? null,
    avatarUrl: author?.avatar_url ?? null,
  };
}

function shapeTopic(t: RawTopic, viewerUpvoted: boolean) {
  return {
    id: t.id,
    locality: t.locality,
    localityLabel: t.locality_label,
    title: t.title,
    body: t.body,
    upvoteCount: t.upvote_count,
    replyCount: t.reply_count,
    lastActivityAt: t.last_activity_at,
    createdAt: t.created_at,
    author: shapeAuthor(t.author),
    viewerUpvoted,
  };
}

/** Resolve the caller (writes only). RLS is the real gate; this gives a friendly 401 + the id. */
async function callerId(db: LooseDb): Promise<string> {
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Could not resolve the signed-in user." });
  }
  return data.user.id;
}

/** The signed-in caller's id, or null when anonymous (public reads merge upvote state when present). */
async function maybeCallerId(db: LooseDb): Promise<string | null> {
  try {
    const { data } = await db.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

/** File a user_report into moderation_queue (0003) — the 0004 RLS policy authorises this exact shape. */
async function fileReport(
  db: LooseDb,
  reporterId: string,
  entityType: "town_hall_topic" | "town_hall_reply",
  entityId: string,
  detail: string | undefined,
): Promise<void> {
  const { error } = (await db.from("moderation_queue").insert({
    entity_type: entityType,
    entity_id: entityId,
    reason: "user_report",
    reporter_id: reporterId,
    detail: detail ?? null,
  })) as { error: { message: string } | null };
  if (error) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't submit your report. Please try again." });
  }
}

export const townHallRouter = router({
  /** Public: a locality's topics, by `popular` (upvotes) or `recent` (last activity). */
  listTopics: publicProcedure
    .input(
      z.object({
        localityName: z.string().trim().min(1).max(120),
        sort: z.enum(["popular", "recent"]).default("recent"),
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
        // An unusable place name simply has no board yet — not an error.
        return { locality: "", localityLabel: input.localityName, topics: [] };
      }

      let q = db.from("town_hall_topics").select(TOPIC_COLS).eq("locality", slug);
      q = input.sort === "popular"
        ? q.order("upvote_count", { ascending: false }).order("last_activity_at", { ascending: false })
        : q.order("last_activity_at", { ascending: false });
      const { data, error } = (await q.limit(input.limit)) as PgResult<RawTopic[] | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load the Town Hall: ${error.message}` });
      }
      const rows = data ?? [];

      // Merge the caller's upvotes (one extra query, scoped to the shown ids) so each topic
      // renders its own ★ state. Anonymous callers see all-false.
      const upvoted = await viewerUpvotes(db, rows.map((r) => r.id));
      return {
        locality: slug,
        localityLabel: label,
        topics: rows.map((t) => shapeTopic(t, upvoted.has(t.id))),
      };
    }),

  /** Public: one topic with its replies (oldest-first), plus the caller's upvote state. */
  getTopic: publicProcedure
    .input(z.object({ topicId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const { data: topic, error } = (await db
        .from("town_hall_topics")
        .select(TOPIC_COLS)
        .eq("id", input.topicId)
        .maybeSingle()) as PgResult<RawTopic | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load this topic: ${error.message}` });
      }
      if (!topic) return null;

      const { data: replyRows, error: rErr } = (await db
        .from("town_hall_replies")
        .select(REPLY_COLS)
        .eq("topic_id", input.topicId)
        .order("created_at", { ascending: true })) as PgResult<RawReply[] | null>;
      if (rErr) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load replies: ${rErr.message}` });
      }

      const upvoted = await viewerUpvotes(db, [topic.id]);
      return {
        topic: shapeTopic(topic, upvoted.has(topic.id)),
        replies: (replyRows ?? []).map((r) => ({
          id: r.id,
          body: r.body,
          createdAt: r.created_at,
          author: shapeAuthor(r.author),
        })),
      };
    }),

  /** Protected: start a topic on the locality the caller is browsing. */
  createTopic: protectedProcedure
    .input(
      z.object({
        localityName: z.string().trim().min(1).max(120),
        title: z.string().min(1).max(TOPIC_TITLE_MAX + 50),
        body: z.string().min(1).max(TOPIC_BODY_MAX + 1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const author_id = await callerId(db);
      let row: { locality: string; locality_label: string; title: string; body: string };
      try {
        row = {
          locality: localitySlug(input.localityName),
          locality_label: localityLabel(input.localityName),
          title: normaliseTopicTitle(input.title),
          body: normaliseTopicBody(input.body),
        };
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : "Invalid topic." });
      }
      const { data, error } = (await db
        .from("town_hall_topics")
        .insert({ ...row, author_id })
        .select("id")
        .single()) as PgResult<{ id: string } | null>;
      if (error || !data) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't post your topic. Please try again." });
      }
      return { id: data.id };
    }),

  /** Protected: reply to a topic (the trigger bumps reply_count + last_activity_at). */
  createReply: protectedProcedure
    .input(z.object({ topicId: z.string().uuid(), body: z.string().min(1).max(REPLY_BODY_MAX + 1000) }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const author_id = await callerId(db);
      let body: string;
      try {
        body = normaliseReplyBody(input.body);
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : "Invalid reply." });
      }
      const { data, error } = (await db
        .from("town_hall_replies")
        .insert({ topic_id: input.topicId, author_id, body })
        .select("id")
        .single()) as PgResult<{ id: string } | null>;
      if (error || !data) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't post your reply. Please try again." });
      }
      return { id: data.id };
    }),

  /** Protected: toggle the caller's single upvote on a topic. Returns the fresh state + count. */
  toggleUpvote: protectedProcedure
    .input(z.object({ topicId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const voter_id = await callerId(db);

      const { data: existing, error: exErr } = (await db
        .from("town_hall_votes")
        .select("topic_id")
        .eq("topic_id", input.topicId)
        .eq("voter_id", voter_id)
        .maybeSingle()) as PgResult<{ topic_id: string } | null>;
      if (exErr) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't update your upvote." });
      }

      if (existing) {
        const { error } = (await db
          .from("town_hall_votes")
          .delete()
          .eq("topic_id", input.topicId)
          .eq("voter_id", voter_id)) as { error: { message: string } | null };
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't remove your upvote." });
      } else {
        const { error } = (await db
          .from("town_hall_votes")
          .insert({ topic_id: input.topicId, voter_id })) as { error: { message: string } | null };
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't add your upvote." });
      }

      // Re-read the trigger-maintained count so the client shows server-truth, not an assumption.
      const { data: fresh } = (await db
        .from("town_hall_topics")
        .select("upvote_count")
        .eq("id", input.topicId)
        .maybeSingle()) as PgResult<{ upvote_count: number } | null>;
      return { upvoted: !existing, upvoteCount: fresh?.upvote_count ?? 0 };
    }),

  /** Protected: report a topic for review. */
  reportTopic: protectedProcedure
    .input(z.object({ topicId: z.string().uuid(), detail: z.string().trim().max(2000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const reporterId = await callerId(db);
      await fileReport(db, reporterId, "town_hall_topic", input.topicId, input.detail);
      return { ok: true as const };
    }),

  /** Protected: report a reply for review. */
  reportReply: protectedProcedure
    .input(z.object({ replyId: z.string().uuid(), detail: z.string().trim().max(2000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const reporterId = await callerId(db);
      await fileReport(db, reporterId, "town_hall_reply", input.replyId, input.detail);
      return { ok: true as const };
    }),
});

/**
 * The subset of `topicIds` the caller has upvoted. Anonymous → empty. RLS scopes the votes
 * table to the caller's own rows, so this is the only query needed (no per-topic round trips).
 */
async function viewerUpvotes(db: LooseDb, topicIds: string[]): Promise<Set<string>> {
  if (topicIds.length === 0) return new Set();
  const me = await maybeCallerId(db);
  if (!me) return new Set();
  const { data } = (await db
    .from("town_hall_votes")
    .select("topic_id")
    .eq("voter_id", me)
    .in("topic_id", topicIds)) as PgResult<{ topic_id: string }[] | null>;
  return new Set((data ?? []).map((v) => v.topic_id));
}
