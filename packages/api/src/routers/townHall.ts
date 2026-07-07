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
import { unfurl } from "../townhall/unfurl.js";

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

const TOPIC_COLS = `id, slug, locality, locality_label, title, body, category, upvote_count, reply_count, link_url, link_domain, link_title, link_image_url, last_activity_at, created_at, ${TOPIC_AUTHOR}`;

/** The topic categories (0066) — the board's filter chips. App-enforced vocabulary. */
const TOPIC_CATEGORIES = ["food-drink", "things-to-do", "recommendations", "events", "neighbourhood"] as const;
const categorySchema = z.enum(TOPIC_CATEGORIES);
const REPLY_COLS = `id, topic_id, body, upvote_count, created_at, ${REPLY_AUTHOR}`;

interface RawTopic {
  id: string;
  slug: string | null;
  locality: string;
  locality_label: string;
  title: string;
  body: string;
  category: string | null;
  upvote_count: number;
  reply_count: number;
  link_url: string | null;
  link_domain: string | null;
  link_title: string | null;
  link_image_url: string | null;
  last_activity_at: string;
  created_at: string;
  author: AuthorEmbed | AuthorEmbed[] | null;
}
interface RawReply {
  id: string;
  topic_id: string;
  body: string;
  upvote_count: number;
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
    slug: t.slug ?? null,
    locality: t.locality,
    localityLabel: t.locality_label,
    title: t.title,
    body: t.body,
    category: t.category,
    upvoteCount: t.upvote_count,
    replyCount: t.reply_count,
    linkUrl: t.link_url,
    linkDomain: t.link_domain,
    linkTitle: t.link_title,
    linkImageUrl: t.link_image_url,
    lastActivityAt: t.last_activity_at,
    createdAt: t.created_at,
    author: shapeAuthor(t.author),
    viewerUpvoted,
  };
}

/** Reddit-style "hot" gravity: upvotes decayed by age, so fresh + upvoted topics rise. */
function hotScore(t: RawTopic, now: number): number {
  const ageHours = Math.max(0, (now - new Date(t.created_at).getTime()) / 3_600_000);
  return t.upvote_count / Math.pow(ageHours + 2, 1.5);
}

function shapeReply(r: RawReply, viewerUpvoted: boolean) {
  return {
    id: r.id,
    body: r.body,
    upvoteCount: r.upvote_count,
    createdAt: r.created_at,
    author: shapeAuthor(r.author),
    viewerUpvoted,
  };
}

/** Best-effort display label from a locality slug when no stored locality_label exists yet
 *  (e.g. an empty town hub): "stockton-on-tees" → "Stockton-on-Tees". */
function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join("-");
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
  /**
   * Public: a locality's topics. Reddit-style sorts:
   *   hot (default) — recent activity ranked by a score/age gravity blend,
   *   new           — most recently created,
   *   top           — highest upvotes all-time.
   * (legacy `recent` → hot, `popular` → top, so older clients keep working.)
   */
  listTopics: publicProcedure
    .input(
      z.object({
        localityName: z.string().trim().min(1).max(120),
        sort: z.enum(["hot", "new", "top", "recent", "popular"]).default("hot"),
        category: categorySchema.optional(),
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

      const sort: "hot" | "new" | "top" =
        input.sort === "new" ? "new" : input.sort === "top" || input.sort === "popular" ? "top" : "hot";

      let q = db.from("town_hall_topics").select(TOPIC_COLS).eq("locality", slug);
      if (input.category) q = q.eq("category", input.category);
      if (sort === "new") q = q.order("created_at", { ascending: false });
      else if (sort === "top") q = q.order("upvote_count", { ascending: false }).order("created_at", { ascending: false });
      else q = q.order("last_activity_at", { ascending: false }); // hot: recent-activity candidates, re-ranked below
      const { data, error } = (await q.limit(input.limit)) as PgResult<RawTopic[] | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load the Town Hall: ${error.message}` });
      }
      let rows = data ?? [];
      if (sort === "hot") {
        const now = Date.now();
        rows = [...rows].sort((a, b) => hotScore(b, now) - hotScore(a, now));
      }

      // Merge the caller's upvotes (one extra query, scoped to the shown ids) so each topic
      // renders its own ★ state. Anonymous callers see all-false.
      const upvoted = await viewerUpvotes(db, rows.map((r) => r.id));
      return {
        locality: slug,
        localityLabel: label,
        topics: rows.map((t) => shapeTopic(t, upvoted.has(t.id))),
      };
    }),

  /**
   * Public: the board's "Active locals" rail — the authors whose topics have earned the most
   * upvotes in this locality recently. Aggregated in JS over the latest 200 topics (a board
   * this size has nowhere near that many), so no new SQL is needed.
   */
  activeLocals: publicProcedure
    .input(z.object({ localityName: z.string().trim().min(1).max(120), limit: z.number().int().min(1).max(10).default(3) }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      let slug: string;
      try {
        slug = localitySlug(input.localityName);
      } catch {
        return { locals: [] };
      }
      const { data, error } = (await db
        .from("town_hall_topics")
        .select(`upvote_count, reply_count, ${TOPIC_AUTHOR}`)
        .eq("locality", slug)
        .order("last_activity_at", { ascending: false })
        .limit(200)) as PgResult<{ upvote_count: number; reply_count: number; author: AuthorEmbed | AuthorEmbed[] | null }[] | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load active locals: ${error.message}` });
      }
      const tally = new Map<
        string,
        {
          author: { id: string | null; handle: string | null; displayName: string | null; avatarUrl: string | null };
          helpfulVotes: number;
          topics: number;
        }
      >();
      for (const row of data ?? []) {
        const author = shapeAuthor(row.author);
        if (!author.id) continue; // deleted accounts don't rank
        const entry = tally.get(author.id) ?? { author, helpfulVotes: 0, topics: 0 };
        entry.helpfulVotes += row.upvote_count;
        entry.topics += 1;
        tally.set(author.id, entry);
      }
      const locals = [...tally.values()]
        .filter((e) => e.helpfulVotes > 0)
        .sort((a, b) => b.helpfulVotes - a.helpfulVotes || b.topics - a.topics)
        .slice(0, input.limit);
      return { locals };
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

      const rows = replyRows ?? [];
      const upvoted = await viewerUpvotes(db, [topic.id]);
      const replyUpvoted = await viewerReplyUpvotes(db, rows.map((r) => r.id));
      return {
        topic: shapeTopic(topic, upvoted.has(topic.id)),
        replies: rows.map((r) => shapeReply(r, replyUpvoted.has(r.id))),
      };
    }),

  /**
   * Public: a town's hub — its topics (most-active first) keyed by the locality SLUG (as it
   * appears in /town-hall/{town}). The label comes from the stored locality_label; an empty town
   * still resolves (hasTopics:false) so the page can offer a "start a topic" state (and noindex
   * itself so thin pages aren't indexed). localitySlug() is idempotent on an already-slug input.
   */
  hub: publicProcedure
    .input(z.object({ locality: z.string().trim().min(1).max(120), limit: z.number().int().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      let slug: string;
      try {
        slug = localitySlug(input.locality);
      } catch {
        return { locality: "", localityLabel: input.locality, hasTopics: false, topics: [] };
      }
      const { data, error } = (await db
        .from("town_hall_topics")
        .select(TOPIC_COLS)
        .eq("locality", slug)
        .order("last_activity_at", { ascending: false })
        .limit(input.limit)) as PgResult<RawTopic[] | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load the Town Hall: ${error.message}` });
      }
      const rows = data ?? [];
      const upvoted = await viewerUpvotes(db, rows.map((r) => r.id));
      const label = rows[0]?.locality_label ?? titleCaseSlug(slug);
      return {
        locality: slug,
        localityLabel: label,
        hasTopics: rows.length > 0,
        topics: rows.map((t) => shapeTopic(t, upvoted.has(t.id))),
      };
    }),

  /**
   * Public: one topic by its (locality, slug) — the canonical lookup behind
   * /town-hall/{town}/{slug}. Mirrors getTopic's shape (topic + oldest-first replies).
   */
  getTopicBySlug: publicProcedure
    .input(z.object({ locality: z.string().trim().min(1).max(120), slug: z.string().trim().min(1).max(120) }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      let slug: string;
      try {
        slug = localitySlug(input.locality);
      } catch {
        return null;
      }
      const { data: topic, error } = (await db
        .from("town_hall_topics")
        .select(TOPIC_COLS)
        .eq("locality", slug)
        .eq("slug", input.slug.toLowerCase())
        .maybeSingle()) as PgResult<RawTopic | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load this topic: ${error.message}` });
      }
      if (!topic) return null;

      const { data: replyRows, error: rErr } = (await db
        .from("town_hall_replies")
        .select(REPLY_COLS)
        .eq("topic_id", topic.id)
        .order("created_at", { ascending: true })) as PgResult<RawReply[] | null>;
      if (rErr) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load replies: ${rErr.message}` });
      }
      const rows = replyRows ?? [];
      const upvoted = await viewerUpvotes(db, [topic.id]);
      const replyUpvoted = await viewerReplyUpvotes(db, rows.map((r) => r.id));
      return {
        topic: shapeTopic(topic, upvoted.has(topic.id)),
        replies: rows.map((r) => shapeReply(r, replyUpvoted.has(r.id))),
      };
    }),

  /**
   * Public: the towns that have a Town Hall board, with their display label and topic count —
   * powers the /town-hall index (directory of town hubs). Deduped + tallied in JS (PostgREST
   * has no GROUP BY here), most-recently-active first.
   */
  localities: publicProcedure.query(async ({ ctx }) => {
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = (await db
      .from("town_hall_topics")
      .select("locality, locality_label, last_activity_at")
      .order("last_activity_at", { ascending: false })
      .limit(20000)) as PgResult<{ locality: string; locality_label: string; last_activity_at: string }[] | null>;
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load town halls: ${error.message}` });
    }
    const map = new Map<string, { locality: string; label: string; topicCount: number; lastActivityAt: string }>();
    for (const row of data ?? []) {
      const ex = map.get(row.locality);
      if (ex) ex.topicCount += 1;
      else map.set(row.locality, { locality: row.locality, label: row.locality_label, topicCount: 1, lastActivityAt: row.last_activity_at });
    }
    return { localities: Array.from(map.values()) };
  }),

  /**
   * Public: preview a URL's link card (domain/title/image) for the composer. SSRF-hardened in
   * unfurl(). Protected so it's only reachable by signed-in posters, not an open fetch proxy.
   */
  previewLink: protectedProcedure
    .input(z.object({ url: z.string().url().max(2000) }))
    .query(async ({ input }): Promise<{ url: string; domain: string; title: string | null; imageUrl: string | null }> => {
      const link = await unfurl(input.url);
      // Return a plain object literal (not unfurl's LinkPreview type) so the tRPC client type
      // stays portable — the web package can't name a type from deep inside node_modules.
      return link
        ? { url: link.url, domain: link.domain, title: link.title, imageUrl: link.imageUrl }
        : { url: input.url, domain: "", title: null, imageUrl: null };
    }),

  /** Protected: start a topic on the locality the caller is browsing (optionally a link post). */
  createTopic: protectedProcedure
    .input(
      z.object({
        localityName: z.string().trim().min(1).max(120),
        title: z.string().min(1).max(TOPIC_TITLE_MAX + 50),
        body: z.string().min(1).max(TOPIC_BODY_MAX + 1000),
        category: categorySchema.optional(),
        linkUrl: z.string().url().max(2000).optional(),
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
      // Unfurl the link SERVER-SIDE so the stored image/title are trusted (never client-supplied).
      const link = input.linkUrl ? await unfurl(input.linkUrl) : null;
      const linkCols = link
        ? { link_url: link.url, link_domain: link.domain || null, link_title: link.title, link_image_url: link.imageUrl }
        : {};
      const { data, error } = (await db
        .from("town_hall_topics")
        .insert({ ...row, ...linkCols, category: input.category ?? null, author_id })
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

  /** Protected: edit your own topic's title / body (RLS author_id = auth.uid() is the gate). */
  updateTopic: protectedProcedure
    .input(
      z.object({
        topicId: z.string().uuid(),
        title: z.string().min(1).max(TOPIC_TITLE_MAX + 50),
        body: z.string().min(1).max(TOPIC_BODY_MAX + 1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      let patch: { title: string; body: string };
      try {
        patch = { title: normaliseTopicTitle(input.title), body: normaliseTopicBody(input.body) };
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : "Invalid topic." });
      }
      // RLS limits the update to the caller's own row; select it back so a no-op (not yours /
      // gone) fails loudly rather than reporting phantom success.
      const { data, error } = (await db
        .from("town_hall_topics")
        .update(patch)
        .eq("id", input.topicId)
        .select("id")
        .maybeSingle()) as PgResult<{ id: string } | null>;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't update your topic." });
      if (!data) throw new TRPCError({ code: "NOT_FOUND", message: "Topic not found, or it isn't yours to edit." });
      return { ok: true as const };
    }),

  /** Protected: delete your own topic (RLS author_id = auth.uid()). Replies cascade in the schema. */
  removeTopic: protectedProcedure
    .input(z.object({ topicId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      const { error } = (await db.from("town_hall_topics").delete().eq("id", input.topicId)) as {
        error: { message: string } | null;
      };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't delete your topic." });
      return { ok: true as const };
    }),

  /** Protected: edit your own reply's body (RLS author_id = auth.uid()). */
  updateReply: protectedProcedure
    .input(z.object({ replyId: z.string().uuid(), body: z.string().min(1).max(REPLY_BODY_MAX + 1000) }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      let body: string;
      try {
        body = normaliseReplyBody(input.body);
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : "Invalid reply." });
      }
      const { data, error } = (await db
        .from("town_hall_replies")
        .update({ body })
        .eq("id", input.replyId)
        .select("id")
        .maybeSingle()) as PgResult<{ id: string } | null>;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't update your reply." });
      if (!data) throw new TRPCError({ code: "NOT_FOUND", message: "Reply not found, or it isn't yours to edit." });
      return { ok: true as const };
    }),

  /** Protected: delete your own reply (RLS author_id = auth.uid()). Trigger decrements reply_count. */
  removeReply: protectedProcedure
    .input(z.object({ replyId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      const { error } = (await db.from("town_hall_replies").delete().eq("id", input.replyId)) as {
        error: { message: string } | null;
      };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't delete your reply." });
      return { ok: true as const };
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

  /** Protected: add/remove your single upvote on a REPLY; counts are trigger-maintained. */
  toggleReplyUpvote: protectedProcedure
    .input(z.object({ replyId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const voter_id = await callerId(db);

      const { data: existing, error: exErr } = (await db
        .from("town_hall_reply_votes")
        .select("reply_id")
        .eq("reply_id", input.replyId)
        .eq("voter_id", voter_id)
        .maybeSingle()) as PgResult<{ reply_id: string } | null>;
      if (exErr) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't update your upvote." });
      }

      if (existing) {
        const { error } = (await db
          .from("town_hall_reply_votes")
          .delete()
          .eq("reply_id", input.replyId)
          .eq("voter_id", voter_id)) as { error: { message: string } | null };
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't remove your upvote." });
      } else {
        const { error } = (await db
          .from("town_hall_reply_votes")
          .insert({ reply_id: input.replyId, voter_id })) as { error: { message: string } | null };
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't add your upvote." });
      }

      const { data: fresh } = (await db
        .from("town_hall_replies")
        .select("upvote_count")
        .eq("id", input.replyId)
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

/** The subset of `replyIds` the caller has upvoted (reply votes). Anonymous → empty. */
async function viewerReplyUpvotes(db: LooseDb, replyIds: string[]): Promise<Set<string>> {
  if (replyIds.length === 0) return new Set();
  const me = await maybeCallerId(db);
  if (!me) return new Set();
  const { data } = (await db
    .from("town_hall_reply_votes")
    .select("reply_id")
    .eq("voter_id", me)
    .in("reply_id", replyIds)) as PgResult<{ reply_id: string }[] | null>;
  return new Set((data ?? []).map((v) => v.reply_id));
}
