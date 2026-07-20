/**
 * PostEngagement — likes + comments for a BUSINESS post (the `posts` feed), the venue-page twin of
 * the profile wall's engagement. One like button + one comments block, used by the home feed card
 * and the post detail page. Talks to trpc.posts.{toggleLike,listComments,addComment,updateComment,
 * removeComment}; self-contained (reads the session for sign-in state), so callers just pass the id
 * and the initial counts from the post payload.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthorLink } from "./AuthorLink";
import { PersonAvatar } from "./UserSearch";
import { linkifyHashtags } from "../lib/hashtags";
import { timeAgo, type TownHallAuthor } from "../lib/townHall";
import actions from "./inlineActions.module.css";

interface PostComment {
  id: string;
  body: string;
  createdAt: string;
  author: TownHallAuthor;
}

/** Heart + count. Optimistic flip, reconciled to the server's fresh state; reverts on error. */
export function PostLikeButton({ postId, initialLiked, initialCount }: { postId: string; initialLiked: boolean; initialCount: number }) {
  const t = useTranslations("postEngagement");
  const trpc = useTrpc();
  const session = useSession();
  const canInteract = !!session;
  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);

  // Keep in sync if the post payload refreshes with new values.
  useEffect(() => { setLiked(initialLiked); setCount(initialCount); }, [initialLiked, initialCount]);

  const toggle = useCallback(async () => {
    if (!canInteract || busy) return;
    setBusy(true);
    const prevLiked = liked;
    const prevCount = count;
    setLiked(!prevLiked);
    setCount(prevCount + (prevLiked ? -1 : 1));
    const mutate = trpc.posts.toggleLike as unknown as { mutate: (i: { postId: string }) => Promise<{ liked: boolean; likeCount: number }> };
    try {
      const res = await mutate.mutate({ postId });
      setLiked(res.liked);
      setCount(res.likeCount);
    } catch {
      setLiked(prevLiked);
      setCount(prevCount);
    } finally {
      setBusy(false);
    }
  }, [trpc, postId, canInteract, busy, liked, count]);

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={!canInteract || busy}
      aria-pressed={liked}
      title={canInteract ? (liked ? t("like.unlike") : t("like.like")) : t("like.signInToLike")}
      style={{ all: "unset", cursor: canInteract ? "pointer" : "default", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: liked ? "var(--crimson-700)" : "var(--ink-2)" }}
    >
      <span aria-hidden style={{ fontSize: 15 }}>{liked ? "♥" : "♡"}</span>
      {count}
    </button>
  );
}

/** A comment-count affordance for the feed card — links to the post so the full thread opens there. */
export function PostCommentLink({ postId, count }: { postId: string; count: number }) {
  const t = useTranslations("postEngagement");
  return (
    <Link
      href={`/feed/${postId}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ink-2)", textDecoration: "none" }}
    >
      <Icon name="chat" size={15} />
      {t("comments.count", { count })}
    </Link>
  );
}

/** The comments block on the post detail page: the list + a composer (or a sign-in nudge). */
export function PostComments({ postId, onCountChange }: { postId: string; onCountChange?: (n: number) => void }) {
  const t = useTranslations("postEngagement");
  const trpc = useTrpc();
  const session = useSession();
  const canInteract = !!session;
  const myId = session?.user?.id ?? null;
  const [comments, setComments] = useState<PostComment[] | undefined>(undefined);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const list = trpc.posts.listComments as unknown as { query: (i: { postId: string }) => Promise<{ comments: PostComment[] }> };
    const res = await list.query({ postId });
    return res.comments ?? [];
  }, [trpc, postId]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((c) => { if (!cancelled) { setComments(c); onCountChange?.(c.length); } })
      .catch(() => { if (!cancelled) setComments([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const refresh = useCallback(async () => {
    const fresh = await load();
    setComments(fresh);
    onCountChange?.(fresh.length);
  }, [load, onCountChange]);

  const submit = useCallback(async () => {
    setBusy(true);
    const add = trpc.posts.addComment as unknown as { mutate: (i: { postId: string; body: string }) => Promise<{ id: string }> };
    try {
      await add.mutate({ postId, body });
      setBody("");
      await refresh();
    } catch {
      /* keep the text so the user can retry */
    } finally {
      setBusy(false);
    }
  }, [trpc, postId, body, refresh]);

  return (
    <div style={{ marginTop: "var(--space-4)", borderTop: "1px solid var(--line)", paddingTop: "var(--space-4)" }}>
      <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15, marginBottom: "var(--space-3)" }}>
        {t("comments.title", { count: comments?.length ?? 0 })}
      </div>
      {comments === undefined ? (
        <div style={{ height: 32, borderRadius: "var(--r-sm)", background: "var(--paper-2)" }} />
      ) : comments.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--muted)" }}>{t("comments.empty")}</p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {comments.map((c) => (
            <CommentRow key={c.id} comment={c} mine={!!myId && c.author.id === myId} onChanged={refresh} />
          ))}
        </div>
      )}

      {canInteract ? (
        <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("comments.placeholder")}
            aria-label={t("comments.addAria")}
            onKeyDown={(e) => { if (e.key === "Enter" && body.trim().length > 0 && !busy) void submit(); }}
            style={{ flex: 1, boxSizing: "border-box", padding: "8px 12px", background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--r-full)", fontFamily: "var(--ui)", fontSize: 16, color: "var(--ink)", outline: "none" }}
          />
          <Button variant="pri" size="sm" onClick={() => void submit()} disabled={body.trim().length === 0 || busy}>
            {busy ? "…" : t("comments.send")}
          </Button>
        </div>
      ) : (
        <p style={{ margin: "var(--space-3) 0 0", fontSize: 12.5, color: "var(--muted)" }}>
          {t.rich("comments.signInToInteract", {
            link: (chunks) => <Link href="/account" style={{ color: "var(--crimson-700)", textDecoration: "none", fontWeight: 600 }}>{chunks}</Link>,
          })}
        </p>
      )}
    </div>
  );
}

/** A single comment with inline edit / delete for its own author. */
function CommentRow({ comment, mine, onChanged }: { comment: PostComment; mine: boolean; onChanged: () => Promise<void> }) {
  const t = useTranslations("postEngagement");
  const trpc = useTrpc();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const save = useCallback(async () => {
    setBusy(true);
    const mut = trpc.posts.updateComment as unknown as { mutate: (i: { commentId: string; body: string }) => Promise<{ ok: true }> };
    try {
      await mut.mutate({ commentId: comment.id, body: draft });
      setEditing(false);
      await onChanged();
    } catch {
      /* keep editing */
    } finally {
      setBusy(false);
    }
  }, [trpc, comment.id, draft, onChanged]);

  const remove = useCallback(async () => {
    setBusy(true);
    const mut = trpc.posts.removeComment as unknown as { mutate: (i: { commentId: string }) => Promise<unknown> };
    try {
      await mut.mutate({ commentId: comment.id });
      await onChanged();
    } catch {
      setBusy(false);
      setConfirming(false);
    }
  }, [trpc, comment.id, onChanged]);

  return (
    <div style={{ display: "flex", gap: 8 }}>
      <PersonAvatar p={comment.author} size={26} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <AuthorLink author={comment.author} style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }} />
        <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 6 }}>{timeAgo(comment.createdAt)}</span>
        {editing ? (
          <div style={{ marginTop: 4 }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={t("comment.editAria")}
              rows={2}
              style={{ width: "100%", boxSizing: "border-box", padding: "8px 12px", background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", fontFamily: "var(--ui)", fontSize: 16, color: "var(--ink)", outline: "none", resize: "vertical", minHeight: 56 }}
            />
            <div style={{ display: "flex", gap: "var(--space-2)", marginTop: 4 }}>
              <Button variant="pri" size="sm" onClick={() => void save()} disabled={busy || draft.trim().length === 0}>{busy ? "…" : t("comment.save")}</Button>
              <Button variant="neutral" size="sm" onClick={() => { setEditing(false); setDraft(comment.body); }} disabled={busy}>{t("comment.cancel")}</Button>
            </div>
          </div>
        ) : (
          <>
            <p style={{ margin: "1px 0 0", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{linkifyHashtags(comment.body)}</p>
            {mine ? (
              confirming ? (
                <div className={actions.row} style={{ marginTop: 4 }}>
                  <span className={actions.confirm}>{t("comment.deleteConfirm")}</span>
                  <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => void remove()} disabled={busy}>{busy ? "…" : t("comment.yes")}</button>
                  <button type="button" className={actions.action} onClick={() => setConfirming(false)} disabled={busy}>{t("comment.no")}</button>
                </div>
              ) : (
                <div className={actions.row} style={{ marginTop: 4 }}>
                  <button type="button" className={actions.action} onClick={() => setEditing(true)}>{t("comment.edit")}</button>
                  <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => setConfirming(true)}>{t("comment.delete")}</button>
                </div>
              )
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
