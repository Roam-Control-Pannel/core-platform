/**
 * Profile-wall router — a user's personal feed (0031_profile_wall.sql): posts (text + images),
 * likes, and comments.
 *
 * Reads are PUBLIC (view any wall signed-out, browse-freely); writes are PROTECTED and act as
 * the caller on their own rows. Owner-posts-only falls out of RLS for free: a post's author_id
 * must equal auth.uid(), so a user can only post to their OWN wall — "their wall" is simply the
 * set of posts they authored.
 *
 *   list        (public)    — a user's posts, newest first, with the viewer's like state.
 *   byId        (public)    — one post by id (the /p/[postId] permalink).
 *   create      (protected) — post to your own wall (text and/or up to 4 images).
 *   remove      (protected) — delete your own post.
 *   toggleLike  (protected) — like/unlike a post; counts are trigger-maintained.
 *   listComments(public)    — a post's comments, oldest first.
 *   addComment  (protected) — comment on a post.
 *   removeComment(protected)— delete your own comment.
 *   reportPost  (protected) — file a user_report into moderation_queue (0003), the backstop.
 *
 * The profile_* tables aren't in the generated DB types, so the client is loose-typed at each
 * call (same idiom as townHall/moderation); every resolver returns an INLINE structural object
 * so no named type leaks into AppRouter.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";
import {
  normaliseWallBody,
  normaliseWallMedia,
  normaliseCommentBody,
  assertPostNotEmpty,
  WALL_BODY_MAX,
  COMMENT_BODY_MAX,
} from "../profile-wall.js";

type PgResult<T> = { data: T; error: { message: string; code?: string } | null };
type LooseDb = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  auth: { getUser: () => Promise<{ data: { user: { id: string } | null }; error: unknown }> };
};

interface AuthorEmbed {
  id: string | null;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

const POST_AUTHOR = "author:profiles!profile_posts_author_id_fkey(id, handle, display_name, avatar_url)";
const COMMENT_AUTHOR = "author:profiles!profile_post_comments_author_id_fkey(id, handle, display_name, avatar_url)";
const POST_COLS = `id, author_id, body, media, like_count, comment_count, created_at, ${POST_AUTHOR}`;
const COMMENT_COLS = `id, post_id, body, created_at, ${COMMENT_AUTHOR}`;

interface RawPost {
  id: string;
  author_id: string;
  body: string | null;
  media: unknown;
  like_count: number;
  comment_count: number;
  created_at: string;
  author: AuthorEmbed | AuthorEmbed[] | null;
}
interface RawComment {
  id: string;
  post_id: string;
  body: string;
  created_at: string;
  author: AuthorEmbed | AuthorEmbed[] | null;
}

function oneAuthor(a: AuthorEmbed | AuthorEmbed[] | null): AuthorEmbed | null {
  return Array.isArray(a) ? (a[0] ?? null) : a;
}
function shapeAuthor(a: AuthorEmbed | AuthorEmbed[] | null) {
  const author = oneAuthor(a);
  return {
    id: author?.id ?? null,
    handle: author?.handle ?? null,
    displayName: author?.display_name ?? null,
    avatarUrl: author?.avatar_url ?? null,
  };
}

/** Media is stored as jsonb; surface image + video items with string urls (defensive). */
function shapeMedia(media: unknown): { type: "image" | "video"; url: string }[] {
  if (!Array.isArray(media)) return [];
  const out: { type: "image" | "video"; url: string }[] = [];
  for (const m of media) {
    const item = m as { type?: unknown; url?: unknown };
    if ((item?.type === "image" || item?.type === "video") && typeof item.url === "string") {
      out.push({ type: item.type, url: item.url });
    }
  }
  return out;
}

function shapePost(p: RawPost, viewerLiked: boolean) {
  return {
    id: p.id,
    authorId: p.author_id,
    body: p.body,
    media: shapeMedia(p.media),
    likeCount: p.like_count,
    commentCount: p.comment_count,
    createdAt: p.created_at,
    author: shapeAuthor(p.author),
    viewerLiked,
  };
}

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

/** The subset of postIds the caller has liked. Anonymous → empty (RLS scopes likes to self). */
async function viewerLikes(db: LooseDb, postIds: string[]): Promise<Set<string>> {
  if (postIds.length === 0) return new Set();
  const me = await maybeCallerId(db);
  if (!me) return new Set();
  const { data } = (await db
    .from("profile_post_likes")
    .select("post_id")
    .eq("liker_id", me)
    .in("post_id", postIds)) as PgResult<{ post_id: string }[] | null>;
  return new Set((data ?? []).map((l) => l.post_id));
}

export const profileWallRouter = router({
  /** Public: a user's wall, newest first, with the viewer's like state per post. */
  list: publicProcedure
    .input(z.object({ userId: z.string().uuid(), limit: z.number().int().min(1).max(50).default(20) }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("profile_posts")
        .select(POST_COLS)
        .eq("author_id", input.userId)
        .order("created_at", { ascending: false })
        .limit(input.limit)) as PgResult<RawPost[] | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load this wall: ${error.message}` });
      }
      const rows = data ?? [];
      const liked = await viewerLikes(db, rows.map((r) => r.id));
      return { posts: rows.map((p) => shapePost(p, liked.has(p.id))) };
    }),

  /** Public: one post by id — the /p/[postId] permalink read. RLS hides non-approved rows. */
  byId: publicProcedure
    .input(z.object({ postId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("profile_posts")
        .select(POST_COLS)
        .eq("id", input.postId)
        .maybeSingle()) as PgResult<RawPost | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load this post: ${error.message}` });
      }
      if (!data) return null;
      const liked = await viewerLikes(db, [data.id]);
      return shapePost(data, liked.has(data.id));
    }),

  /** Protected: post to your own wall (text and/or images). */
  create: protectedProcedure
    .input(
      z.object({
        body: z.string().max(WALL_BODY_MAX + 1000).nullish(),
        media: z.array(z.object({ type: z.enum(["image", "video"]), url: z.string().max(4096) })).max(8).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const author_id = await callerId(db);
      let body: string | null;
      let media: { type: "image" | "video"; url: string }[];
      try {
        body = normaliseWallBody(input.body ?? null);
        media = normaliseWallMedia(input.media);
        assertPostNotEmpty(body, media);
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : "Invalid post." });
      }
      const { data, error } = (await db
        .from("profile_posts")
        .insert({ author_id, body, media })
        .select("id")
        .single()) as PgResult<{ id: string } | null>;
      if (error || !data) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't post that. Please try again." });
      }
      return { id: data.id };
    }),

  /** Protected: edit your own post — body and/or media (RLS author_id = auth.uid()). Full replace
   *  of the editable fields, mirroring create's normalisation; an empty post is rejected. */
  update: protectedProcedure
    .input(
      z.object({
        postId: z.string().uuid(),
        body: z.string().max(WALL_BODY_MAX + 1000).nullish(),
        media: z.array(z.object({ type: z.enum(["image", "video"]), url: z.string().max(4096) })).max(8).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      let body: string | null;
      let media: { type: "image" | "video"; url: string }[];
      try {
        body = normaliseWallBody(input.body ?? null);
        media = normaliseWallMedia(input.media);
        assertPostNotEmpty(body, media);
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : "Invalid post." });
      }
      const { data, error } = (await db
        .from("profile_posts")
        .update({ body, media })
        .eq("id", input.postId)
        .select("id")
        .maybeSingle()) as PgResult<{ id: string } | null>;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't update that post." });
      if (!data) throw new TRPCError({ code: "NOT_FOUND", message: "Post not found, or it isn't yours to edit." });
      return { ok: true as const };
    }),

  /** Protected: delete your own post (RLS enforces ownership). */
  remove: protectedProcedure
    .input(z.object({ postId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      const { error } = (await db.from("profile_posts").delete().eq("id", input.postId)) as {
        error: { message: string } | null;
      };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't delete that post." });
      return { ok: true as const };
    }),

  /** Protected: toggle the caller's like on a post. Returns the fresh state + count. */
  toggleLike: protectedProcedure
    .input(z.object({ postId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const liker_id = await callerId(db);

      const { data: existing, error: exErr } = (await db
        .from("profile_post_likes")
        .select("post_id")
        .eq("post_id", input.postId)
        .eq("liker_id", liker_id)
        .maybeSingle()) as PgResult<{ post_id: string } | null>;
      if (exErr) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't update your like." });

      if (existing) {
        const { error } = (await db
          .from("profile_post_likes")
          .delete()
          .eq("post_id", input.postId)
          .eq("liker_id", liker_id)) as { error: { message: string } | null };
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't remove your like." });
      } else {
        const { error } = (await db
          .from("profile_post_likes")
          .insert({ post_id: input.postId, liker_id })) as { error: { message: string } | null };
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't add your like." });
      }

      const { data: fresh } = (await db
        .from("profile_posts")
        .select("like_count")
        .eq("id", input.postId)
        .maybeSingle()) as PgResult<{ like_count: number } | null>;
      return { liked: !existing, likeCount: fresh?.like_count ?? 0 };
    }),

  /** Public: a post's comments, oldest first. */
  listComments: publicProcedure
    .input(z.object({ postId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("profile_post_comments")
        .select(COMMENT_COLS)
        .eq("post_id", input.postId)
        .order("created_at", { ascending: true })) as PgResult<RawComment[] | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load comments: ${error.message}` });
      }
      return {
        comments: (data ?? []).map((c) => ({
          id: c.id,
          body: c.body,
          createdAt: c.created_at,
          author: shapeAuthor(c.author),
        })),
      };
    }),

  /** Protected: comment on a post (the trigger bumps comment_count). */
  addComment: protectedProcedure
    .input(z.object({ postId: z.string().uuid(), body: z.string().min(1).max(COMMENT_BODY_MAX + 500) }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const author_id = await callerId(db);
      let body: string;
      try {
        body = normaliseCommentBody(input.body);
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : "Invalid comment." });
      }
      const { data, error } = (await db
        .from("profile_post_comments")
        .insert({ post_id: input.postId, author_id, body })
        .select("id")
        .single()) as PgResult<{ id: string } | null>;
      if (error || !data) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't post your comment." });
      }
      return { id: data.id };
    }),

  /** Protected: edit your own comment's body (RLS author_id = auth.uid()). */
  updateComment: protectedProcedure
    .input(z.object({ commentId: z.string().uuid(), body: z.string().min(1).max(COMMENT_BODY_MAX + 500) }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      let body: string;
      try {
        body = normaliseCommentBody(input.body);
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : "Invalid comment." });
      }
      const { data, error } = (await db
        .from("profile_post_comments")
        .update({ body })
        .eq("id", input.commentId)
        .select("id")
        .maybeSingle()) as PgResult<{ id: string } | null>;
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't update that comment." });
      if (!data) throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found, or it isn't yours to edit." });
      return { ok: true as const };
    }),

  /** Protected: delete your own comment. */
  removeComment: protectedProcedure
    .input(z.object({ commentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      const { error } = (await db.from("profile_post_comments").delete().eq("id", input.commentId)) as {
        error: { message: string } | null;
      };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't delete that comment." });
      return { ok: true as const };
    }),

  /** Protected: report a post for review (file a user_report into moderation_queue). */
  reportPost: protectedProcedure
    .input(z.object({ postId: z.string().uuid(), detail: z.string().trim().max(2000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const reporterId = await callerId(db);
      const { error } = (await db.from("moderation_queue").insert({
        entity_type: "profile_post",
        entity_id: input.postId,
        reason: "user_report",
        reporter_id: reporterId,
        detail: input.detail ?? null,
      })) as { error: { message: string } | null };
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't submit your report. Please try again." });
      }
      return { ok: true as const };
    }),
});
