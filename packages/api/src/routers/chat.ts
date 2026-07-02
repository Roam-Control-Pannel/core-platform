/**
 * Chat router — Stage 2b thread/plan plumbing.
 *
 * Makes the meet-up flow reachable from real app actions. Before this, threads +
 * participants existed only via manual SQL seed (exactly what Stage 2a's proof had
 * to do). This router is the bridge: create a thread, add participants, spawn a
 * thread from a plan — after which meetup.createMeetup({ threadId }) can run.
 *
 * Procedures:
 * - createThread          : create a thread AND atomically add the caller as its first
 *                           participant, via the create_thread_with_creator RPC
 *                           (migration 0011, SECURITY DEFINER). Optional plan_id links
 *                           the thread to a plan (chat_threads.plan_id); optional title;
 *                           is_group defaults false. The "creator is a participant"
 *                           invariant lives in the DB function, not here — there is no
 *                           other INSERT path to chat_threads.
 * - addThreadParticipant  : add ANOTHER profile to an EXISTING thread. RLS policy
 *                           chat_participants_write (WITH CHECK in_thread(thread_id))
 *                           enforces that the CALLER is already in the thread; this
 *                           router additionally guards that the thread is a group
 *                           (a 1:1 → group promotion is a deliberate product decision,
 *                           not an accident). Idempotent on PK (thread_id, profile_id).
 *
 * Architecture notes:
 * - createThread calls an RPC that isn't in the generated DB types until `pnpm db:types`
 *   is re-pointed at prod and re-run, so we widen JUST that call through a minimal rpc
 *   surface — the same idiom venues.ts uses for venues_near / request_venue_claim. The
 *   rest of ctx.db stays fully typed. (Tech-debt cleanup tracked separately: repoint
 *   db:types at prod, then revert all rpc-widening to plain typed calls.)
 * - The is_group group-only guard is router-side VALIDATION, not a business rule — it
 *   mirrors meetup.ts's assertVoting: changeable product rules live in the router; the
 *   creator-participant invariant lives in the DB.
 * - SQLSTATE → tRPC error mapping mirrors venues.ts: the function raises 28000 if no
 *   authenticated user (defensive — protectedProcedure already guarantees a JWT).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { RoamClient } from "@roam/db";
import { messaging } from "@roam/core";
import { router, protectedProcedure } from "../trpc.js";

/**
 * Shape returned by the `create_thread_with_creator` RPC (migration 0011) — a single
 * chat_threads row. The function isn't in the generated DB types until db:types is
 * re-run against prod, so we type it explicitly and widen the .rpc() call. Keep in
 * sync with the chat_threads table definition.
 */
interface ChatThreadRow {
  id: string;
  is_group: boolean;
  plan_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Postgres error codes create_thread_with_creator raises (via `using errcode`),
 * mapped to friendly, typed outcomes — same pattern as venues.ts's claim mapping.
 */
const THREAD_ERROR_BY_SQLSTATE: Record<string, { code: TRPCError["code"]; message: string }> = {
  "28000": { code: "UNAUTHORIZED", message: "You need to be signed in to start a chat." },
};

/** Resolve the caller's auth user id from the validated session JWT. */
async function callerId(db: RoamClient): Promise<string> {
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Could not resolve the signed-in user.",
    });
  }
  return data.user.id;
}

export const chatRouter = router({
  /**
   * Create a thread and atomically add the caller as its first participant.
   * Delegates entirely to the create_thread_with_creator RPC — the two inserts
   * happen in one transaction under SECURITY DEFINER, so a thread can never exist
   * without its creator-participant. Returns the new thread row.
   */
  createThread: protectedProcedure
    .input(
      z.object({
        isGroup: z.boolean().default(false),
        planId: z.string().uuid().optional(),
        title: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // create_thread_with_creator isn't in the generated DB types until db:types is
      // re-run against prod; widen JUST this call (same idiom as venues.ts).
      const rpc = ctx.db.rpc.bind(ctx.db) as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{
        data: unknown;
        error: { message: string; code?: string } | null;
      }>;

      const { data, error } = await rpc("create_thread_with_creator", {
        p_is_group: input.isGroup,
        p_plan_id: input.planId ?? null,
        p_title: input.title ?? null,
      });

      if (error) {
        const mapped = error.code ? THREAD_ERROR_BY_SQLSTATE[error.code] : undefined;
        if (mapped) {
          throw new TRPCError({ code: mapped.code, message: mapped.message });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Couldn't create the chat. Please try again.",
        });
      }

      const thread = data as ChatThreadRow;
      return {
        id: thread.id,
        isGroup: thread.is_group,
        planId: thread.plan_id,
        title: thread.title,
        createdAt: thread.created_at,
      };
    }),

  /**
   * Create a GROUP thread with members in one call — the WhatsApp "New group" flow. Creates the
   * thread (creator added atomically by create_thread_with_creator) then bulk-adds the chosen
   * members. RLS (chat_participants_write = in_thread) passes because the caller is already a
   * participant after the RPC. Idempotent on the PK; self/dupes are filtered out. For a 1:1 the
   * client uses directThread instead (deduped DM) — this is strictly multi-person.
   */
  createGroupThread: protectedProcedure
    .input(
      z.object({
        title: z.string().trim().min(1).max(200),
        memberIds: z.array(z.string().uuid()).min(1).max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const me = await callerId(ctx.db);

      const rpc = ctx.db.rpc.bind(ctx.db) as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
      const { data, error } = await rpc("create_thread_with_creator", {
        p_is_group: true,
        p_plan_id: null,
        p_title: input.title,
      });
      if (error) {
        const mapped = error.code ? THREAD_ERROR_BY_SQLSTATE[error.code] : undefined;
        if (mapped) throw new TRPCError({ code: mapped.code, message: mapped.message });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't create the group. Please try again." });
      }
      const thread = data as ChatThreadRow;

      // Bulk-add the members (excluding the creator + duplicates). One insert; RLS checks each row.
      const others = Array.from(new Set(input.memberIds)).filter((id) => id !== me);
      if (others.length > 0) {
        const { error: addErr } = await ctx.db
          .from("chat_participants")
          .upsert(
            others.map((profile_id) => ({ thread_id: thread.id, profile_id })),
            { onConflict: "thread_id,profile_id", ignoreDuplicates: true },
          );
        if (addErr) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Group created but adding people failed: ${addErr.message}` });
        }
      }

      return { id: thread.id, title: thread.title };
    }),

  /**
   * Add another profile to an existing GROUP thread. RLS (chat_participants_write)
   * enforces that the caller is already in the thread; this guard rejects adding to
   * a 1:1 thread (promote to group first — a separate, deliberate action). Idempotent
   * via upsert on the PK (thread_id, profile_id): re-adding the same profile is a no-op.
   */
  addThreadParticipant: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
        profileId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Caller must be resolvable (defensive; protectedProcedure guarantees a JWT).
      await callerId(ctx.db);

      // Load the thread the caller can see (RLS scopes this to threads they're in).
      // NOT_FOUND covers both "no such thread" and "not visible to you" — we never
      // confirm existence of a thread the caller isn't a participant of.
      const { data: thread, error: threadErr } = await ctx.db
        .from("chat_threads")
        .select("id, is_group")
        .eq("id", input.threadId)
        .maybeSingle();
      if (threadErr) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to load thread: ${threadErr.message}`,
        });
      }
      if (!thread) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Thread not found, or you do not have access to it.",
        });
      }

      // Group-only guard: a 1:1 thread gaining a third person is really a new group.
      if (!thread.is_group) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This is a direct chat. Start a group chat to add more people.",
        });
      }

      // Idempotent add. RLS WITH CHECK in_thread(thread_id) enforces the caller is a
      // participant; we pass profile_id explicitly (belt-and-braces, not a bypass).
      const { data, error } = await ctx.db
        .from("chat_participants")
        .upsert(
          { thread_id: input.threadId, profile_id: input.profileId },
          { onConflict: "thread_id,profile_id", ignoreDuplicates: false },
        )
        .select("thread_id, profile_id, created_at")
        .single();
      if (error || !data) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to add participant: ${error?.message ?? "no row returned"}`,
        });
      }
      return {
        threadId: data.thread_id,
        profileId: data.profile_id,
        addedAt: data.created_at,
      };
    }),

  /**
   * Get-or-create the 1:1 direct chat between the caller and another profile. Delegates to
   * the get_or_create_direct_thread RPC (migration 0035, SECURITY DEFINER), which DEDUPES —
   * returns the existing DM if one already joins exactly the two of them, else makes one with
   * both as participants. This is the "Message someone" entry point from a wall / friends list,
   * the direct-chat half of the chat/plans split (plan chats are plans.chat).
   */
  directThread: protectedProcedure
    .input(z.object({ profileId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const rpc = ctx.db.rpc.bind(ctx.db) as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;

      const { data, error } = await rpc("get_or_create_direct_thread", { p_other: input.profileId });
      if (error) {
        const mapped = error.code ? THREAD_ERROR_BY_SQLSTATE[error.code] : undefined;
        if (mapped) throw new TRPCError({ code: mapped.code, message: mapped.message });
        if (error.code === "22023") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "You can't start a chat with yourself." });
        }
        if (error.code === "P0002") {
          throw new TRPCError({ code: "NOT_FOUND", message: "That person no longer exists." });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't open the chat. Please try again." });
      }
      const thread = data as ChatThreadRow | null;
      if (!thread?.id) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't open the chat. Please try again." });
      }
      return { threadId: thread.id };
    }),

  /**
   * List the caller's threads, most-recently-active first. RLS (chat_threads_read,
   * gated on in_thread) already scopes the select to threads the caller is a
   * participant of, so a plain select returns exactly their inbox — no explicit
   * membership filter needed.
   *
   * Each thread is classified into a `kind` so the inbox can distinguish the three
   * surfaces of the chat/plans split: 'plan' (a plan's group chat — plan_id set),
   * 'group' (a free-standing group), 'direct' (a 1:1 DM). The display `name` is derived
   * per kind: the title for group/plan, and the OTHER person's name for a DM (a 1:1
   * has no title). Participants embed their profiles (RLS scopes the embed to rows the
   * caller can read, which for a thread they're in is all of them), normalised
   * array-or-object the same way getThread does.
   */
  listThreads: protectedProcedure.query(async ({ ctx }) => {
    const me = await callerId(ctx.db);
    const { data, error } = await ctx.db
      .from("chat_threads")
      .select(
        "id, is_group, plan_id, title, updated_at, chat_participants(profile_id, profiles(display_name, handle, avatar_url))",
      )
      .order("updated_at", { ascending: false });
    if (error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Failed to load chats: ${error.message}`,
      });
    }

    // Per-thread last-message preview + unread count (thread_inbox RPC). Not in the generated DB
    // types yet, so widen just this call. A failure here degrades to "no preview / 0 unread"
    // rather than failing the whole inbox — the list is more important than the badges.
    const looseRpc = ctx.db.rpc.bind(ctx.db) as unknown as (
      fn: string,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
    type InboxMetaRow = {
      thread_id: string;
      last_kind: string | null;
      last_body: string | null;
      last_sender_id: string | null;
      last_created_at: string | null;
      unread_count: number | null;
    };
    const metaById = new Map<string, InboxMetaRow>();
    try {
      const { data: meta } = await looseRpc("thread_inbox");
      for (const r of (meta as InboxMetaRow[] | null) ?? []) metaById.set(r.thread_id, r);
    } catch {
      /* leave metaById empty */
    }

    type EmbeddedProfile = { display_name: string | null; handle: string | null; avatar_url: string | null };
    type PartRow = { profile_id: string; profiles?: unknown };

    const rows = (data ?? []).map((t) => {
      const raw = (t as { chat_participants?: unknown }).chat_participants;
      const parts: PartRow[] = Array.isArray(raw) ? (raw as PartRow[]) : raw ? [raw as PartRow] : [];

      const kind: "plan" | "group" | "direct" = t.plan_id ? "plan" : t.is_group ? "group" : "direct";

      // For a DM, the display name is the OTHER participant; for group/plan it's the title.
      let name = t.title?.trim() || null;
      if (kind === "direct") {
        const other = parts.find((p) => p.profile_id !== me) ?? parts[0];
        const rawProf = (other as { profiles?: unknown } | undefined)?.profiles;
        const prof: EmbeddedProfile | null = Array.isArray(rawProf)
          ? ((rawProf[0] as EmbeddedProfile | undefined) ?? null)
          : ((rawProf as EmbeddedProfile | null) ?? null);
        name = prof?.display_name?.trim() || (prof?.handle ? `@${prof.handle}` : null);
      }

      const meta = metaById.get(t.id) ?? null;
      const lastMessage = meta && meta.last_created_at
        ? {
            kind: meta.last_kind ?? "text",
            body: meta.last_body ?? null,
            senderId: meta.last_sender_id ?? null,
            createdAt: meta.last_created_at,
          }
        : null;

      return {
        id: t.id,
        isGroup: t.is_group,
        planId: t.plan_id,
        kind,
        title: t.title,
        name,
        updatedAt: t.updated_at,
        participantCount: parts.length,
        lastMessage,
        unreadCount: Number(meta?.unread_count ?? 0),
      };
    });

    // Order the inbox by REAL activity (newest message first), falling back to the thread's
    // updated_at when it has no messages yet — so a thread jumps to the top when someone posts.
    return rows.sort((a, b) => {
      const at = new Date(a.lastMessage?.createdAt ?? a.updatedAt).getTime();
      const bt = new Date(b.lastMessage?.createdAt ?? b.updatedAt).getTime();
      return bt - at;
    });
  }),

  /**
   * Mark a thread read for the caller (stamps chat_participants.last_read_at = now via the
   * mark_thread_read RPC, which only ever writes the caller's own row). Called when a thread is
   * opened; clears its unread badge in the inbox on next load.
   */
  markRead: protectedProcedure
    .input(z.object({ threadId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const looseRpc = ctx.db.rpc.bind(ctx.db) as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ error: { message: string } | null }>;
      const { error } = await looseRpc("mark_thread_read", { p_thread: input.threadId });
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't mark read: ${error.message}` });
      }
      return { ok: true as const };
    }),

  /**
   * Read one thread with its participants, for the detail view. RLS scopes the
   * thread select to ones the caller is in; NOT_FOUND covers both "no such thread"
   * and "not visible to you" (we never confirm existence of a thread the caller
   * isn't in) — mirroring meetup.ts's loadState.
   *
   * Participants embed profiles via the chat_participants -> profiles FK. Profile
   * fields are all nullable (display_name/handle/avatar_url); the UI degrades
   * gracefully. The embed is read through unknown and normalised (array-or-object),
   * the same idiom posts.ts uses for its venue embed.
   */
  getThread: protectedProcedure
    .input(z.object({ threadId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { data: thread, error: threadErr } = await ctx.db
        .from("chat_threads")
        .select("id, is_group, plan_id, title, created_at, updated_at")
        .eq("id", input.threadId)
        .maybeSingle();
      if (threadErr) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to load chat: ${threadErr.message}`,
        });
      }
      if (!thread) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Chat not found, or you do not have access to it.",
        });
      }

      const { data: partRows, error: partErr } = await ctx.db
        .from("chat_participants")
        .select("profile_id, created_at, profiles(display_name, handle, avatar_url)")
        .eq("thread_id", input.threadId)
        .order("created_at", { ascending: true });
      if (partErr) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to load participants: ${partErr.message}`,
        });
      }

      type EmbeddedProfile = {
        display_name: string | null;
        handle: string | null;
        avatar_url: string | null;
      };
      const participants = (partRows ?? []).map((p) => {
        const raw = (p as { profiles?: unknown }).profiles;
        const prof: EmbeddedProfile | null = Array.isArray(raw)
          ? ((raw[0] as EmbeddedProfile | undefined) ?? null)
          : ((raw as EmbeddedProfile | null) ?? null);
        return {
          profileId: p.profile_id,
          displayName: prof?.display_name ?? null,
          handle: prof?.handle ?? null,
          avatarUrl: prof?.avatar_url ?? null,
          joinedAt: p.created_at,
        };
      });

      return {
        id: thread.id,
        isGroup: thread.is_group,
        planId: thread.plan_id,
        title: thread.title,
        createdAt: thread.created_at,
        updatedAt: thread.updated_at,
        participants,
      };
    }),

  /**
   * List a thread's messages, oldest-first (the existing (thread_id, created_at)
   * index in migration 0002). RLS (chat_messages_read = in_thread) already scopes
   * the select to threads the caller participates in, so a thread the caller can't
   * see simply returns no rows.
   *
   * MODERATION READ MODEL: mirrors posts_read_public — visible messages are those
   * with moderation in ('auto_approved','approved'). Text auto-approves on send
   * (see sendMessage), so a sent message is immediately visible to the whole thread;
   * when the moderation Edge scanner lands it runs post-insert and can demote a row
   * to auto_flagged/rejected, which this same filter then hides. RLS returns all
   * in-thread rows; this content-status filter is applied in TS (the moderation
   * column isn't part of the RLS predicate).
   *
   * Scope: kind='text' is what this slice renders, but we do NOT filter by kind in
   * the read — the rich-kind seam (venue_card/poll/...) stays open; the UI decides
   * what it can render. sender display is embedded via the chat_messages -> profiles
   * FK, normalised array-or-object exactly like getThread's participant embed.
   */
  listMessages: protectedProcedure
    .input(z.object({ threadId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from("chat_messages")
        .select(
          "id, sender_id, body, kind, payload, moderation, created_at, profiles(display_name, handle, avatar_url)",
        )
        .eq("thread_id", input.threadId)
        .order("created_at", { ascending: true });
      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to load messages: ${error.message}`,
        });
      }

      type EmbeddedProfile = {
        display_name: string | null;
        handle: string | null;
        avatar_url: string | null;
      };
      const visible = (data ?? []).filter(
        (m) => m.moderation === "auto_approved" || m.moderation === "approved",
      );

      return visible.map((m) => {
        const raw = (m as { profiles?: unknown }).profiles;
        const prof: EmbeddedProfile | null = Array.isArray(raw)
          ? ((raw[0] as EmbeddedProfile | undefined) ?? null)
          : ((raw as EmbeddedProfile | null) ?? null);
        return {
          id: m.id,
          senderId: m.sender_id,
          body: m.body,
          kind: m.kind,
          payload: ((m as { payload?: unknown }).payload ?? null) as Record<string, unknown> | null,
          createdAt: m.created_at,
          senderName: prof?.display_name ?? null,
          senderHandle: prof?.handle ?? null,
          senderAvatar: prof?.avatar_url ?? null,
        };
      });
    }),

  /**
   * Send a text message to a thread. RLS (chat_messages_insert) enforces
   * sender_id = auth.uid() AND in_thread(thread_id), so a non-participant's insert
   * is denied. We resolve sender_id from the validated JWT and pass it explicitly
   * (belt-and-braces, mirroring social.ts / meetup.ts), and .select() the row back,
   * throwing on a zero-row result — the banked lesson: a write that matches no row
   * (e.g. a denied insert) must fail loudly, never report phantom success.
   *
   * kind is hard-coded 'text' this slice (the rich-kind seam stays unbuilt). body
   * is trimmed and required non-empty; an empty message is meaningless.
   */
  sendMessage: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
        // kind + payload open the rich-kind seam: text (default), venue_card, plan_card,
        // profile_card, image. The shape is validated by @roam/core (single source of truth,
        // shared with native) — body is required for text, optional as a caption for a card.
        kind: z.enum([...messaging.MESSAGE_KINDS] as [string, ...string[]]).optional(),
        body: z.string().max(4000).optional(),
        payload: z.unknown().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sender_id = await callerId(ctx.db);

      // Validate + normalize against the kind's contract before any write (core, not zod:
      // one definition rendered by every surface). A malformed card never reaches the table.
      const v = messaging.validateMessage({ kind: input.kind ?? "text", body: input.body, payload: input.payload });
      if (!v.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: v.error });
      }
      const { kind, body, payload } = v.message;

      // payload is not in the generated DB types until db:types is re-pointed at prod, so this
      // one insert+select goes through a loose surface (same idiom as plans.ts / venues.ts).
      const looseDb = ctx.db as unknown as {
        from: (t: string) => {
          insert: (v: Record<string, unknown>) => {
            select: (c: string) => {
              single: () => Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
            };
          };
        };
      };
      const { data, error } = await looseDb
        .from("chat_messages")
        .insert({
          thread_id: input.threadId,
          sender_id,
          body,
          kind,
          payload,
          // Auto-approves on send: the moderation Edge scanner runs POST-insert (flagging/
          // rejecting async into moderation_queue), so a message must be visible to the thread
          // immediately — a 'pending' default with no scanner to clear it would make every
          // message invisible to non-senders. Optimistic-publish + async-moderation; the scanner
          // can still demote a row later. Rich cards are entity references, low-risk to surface.
          moderation: "auto_approved",
        })
        .select("id, sender_id, body, kind, payload, created_at")
        .single();
      if (error || !data) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to send message: ${error?.message ?? "no row returned"}`,
        });
      }
      return {
        id: data.id,
        senderId: data.sender_id,
        body: data.body,
        kind: data.kind,
        payload: ((data as { payload?: unknown }).payload ?? null) as Record<string, unknown> | null,
        createdAt: data.created_at,
      };
    }),

  /**
   * Edit your own message. RLS (chat_messages_update) scopes the write to the caller's
   * own rows; we .select() the row back and throw NOT_FOUND on a zero-row result, so an
   * edit that matched nothing (not yours / gone) fails loudly rather than reporting
   * phantom success. Re-stamps moderation to 'auto_approved' — same optimistic-publish
   * posture as sendMessage (the async scanner can still demote the edited text later).
   */
  editMessage: protectedProcedure
    .input(z.object({ messageId: z.string().uuid(), body: z.string().trim().min(1).max(4000) }))
    .mutation(async ({ ctx, input }) => {
      await callerId(ctx.db);
      const { data, error } = await ctx.db
        .from("chat_messages")
        .update({ body: input.body, moderation: "auto_approved" })
        .eq("id", input.messageId)
        .select("id, body, created_at")
        .maybeSingle();
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to edit message: ${error.message}` });
      }
      if (!data) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Message not found, or it isn't yours to edit." });
      }
      return { id: data.id, body: data.body, createdAt: data.created_at };
    }),

  /** Delete your own message (RLS chat_messages_delete = sender_id is the caller). */
  deleteMessage: protectedProcedure
    .input(z.object({ messageId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await callerId(ctx.db);
      const { error } = await ctx.db.from("chat_messages").delete().eq("id", input.messageId);
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to delete message: ${error.message}` });
      }
      return { ok: true as const };
    }),

  /**
   * Rename a free-standing GROUP thread. Plan chats are excluded (their title tracks the
   * plan) and direct chats have no title — both rejected here, mirroring addThreadParticipant's
   * group-only guard. RLS (chat_threads_update) enforces the caller is a participant.
   */
  renameThread: protectedProcedure
    .input(z.object({ threadId: z.string().uuid(), title: z.string().trim().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      await callerId(ctx.db);
      const { data: thread, error: loadErr } = await ctx.db
        .from("chat_threads")
        .select("id, is_group, plan_id")
        .eq("id", input.threadId)
        .maybeSingle();
      if (loadErr) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load thread: ${loadErr.message}` });
      }
      if (!thread) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Chat not found, or you do not have access to it." });
      }
      if (!thread.is_group || thread.plan_id) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: thread.plan_id ? "A plan chat is named after its plan." : "Only group chats can be renamed.",
        });
      }
      const { data, error } = await ctx.db
        .from("chat_threads")
        .update({ title: input.title })
        .eq("id", input.threadId)
        .select("id, title")
        .maybeSingle();
      if (error || !data) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to rename chat: ${error?.message ?? "no row"}` });
      }
      return { id: data.id, title: data.title };
    }),

  /**
   * Leave a thread — remove the caller's own participant row (RLS chat_participants_leave).
   * For a plan chat the caller would simply be re-added the next time they open it while still
   * a plan member, so leaving is meaningful for direct + free-standing group chats.
   */
  leaveThread: protectedProcedure
    .input(z.object({ threadId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const me = await callerId(ctx.db);
      const { error } = await ctx.db
        .from("chat_participants")
        .delete()
        .eq("thread_id", input.threadId)
        .eq("profile_id", me);
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to leave chat: ${error.message}` });
      }
      return { ok: true as const };
    }),
});
