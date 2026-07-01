/**
 * LocalPosts — the business's posting surface inside the dashboard (the LinkedIn-business-page
 * model). The venue posts on its own behalf: a "local post" lands on the venue's public page
 * (Posts tab, via posts.byVenue) AND in the town's local news feed (posts.feed, geofenced) —
 * because every post here targets destinations ['profile','feed']. An optional "Notify followers"
 * adds a follower push (costs one credit; the server blocks if the venue can't afford it).
 *
 * Owner-only by RLS (posts_owner_all). Lists the venue's posts (posts.mine — incl. drafts) with
 * inline edit (title/body) and delete, mirroring the consumer self-edit/delete contract.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Button, Seg } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { uploadProfileImage } from "../lib/uploadProfileImage";
import actions from "./inlineActions.module.css";

type PostKind = "news" | "offer" | "event";
interface PostMedia { type: "image"; url: string }
const MAX_POST_IMAGES = 4;

interface ManagedPost {
  id: string;
  kind: string;
  title: string | null;
  body: string | null;
  media: PostMedia[];
  destinations: string[];
  isDraft: boolean;
  publishAt: string | null;
  publishedAt: string | null;
  createdAt: string;
}

interface CreateResult {
  created: boolean;
  validation?: { ok: boolean; errors: string[] };
  reason?: "insufficient_credits";
  balance?: number;
  postId?: string;
}

const KIND_OPTIONS = [
  { value: "news", label: "News" },
  { value: "offer", label: "Offer" },
  { value: "event", label: "Event" },
] as const;

function postState(p: ManagedPost): { label: string; live: boolean } {
  if (p.publishedAt) return { label: "Live", live: true };
  if (p.publishAt) return { label: "Scheduled", live: false };
  return { label: "Draft", live: false };
}

/** A small "where it went" chip on a post row (local feed / pushed to followers). */
function DestBadge({ children, push }: { children: React.ReactNode; push?: boolean }) {
  return (
    <span
      style={{
        fontFamily: "var(--mono)",
        fontSize: 9,
        letterSpacing: ".05em",
        textTransform: "uppercase",
        color: push ? "var(--crimson-700)" : "var(--muted)",
        background: push ? "var(--crimson-tint)" : "var(--paper-2)",
        border: `1px solid ${push ? "var(--crimson-tint-2)" : "var(--line)"}`,
        borderRadius: 999,
        padding: "1px 7px",
      }}
    >
      {children}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  marginTop: "var(--space-2)",
  background: "var(--paper-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-md)",
  fontFamily: "var(--ui)",
  fontSize: 16,
  color: "var(--ink)",
  outline: "none",
};

export function LocalPosts({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const [posts, setPosts] = useState<ManagedPost[] | undefined>(undefined);
  const [composing, setComposing] = useState(false);

  const load = useCallback(async () => {
    const q = trpc.posts.mine as unknown as { query: (i: { venueId: string }) => Promise<ManagedPost[]> };
    return q.query({ venueId });
  }, [trpc, venueId]);

  const refresh = useCallback(() => {
    void load().then(setPosts).catch(() => setPosts([]));
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((p) => { if (!cancelled) setPosts(p); })
      .catch(() => { if (!cancelled) setPosts([]); });
    return () => { cancelled = true; };
  }, [load]);

  return (
    <div>
      {composing ? (
        <PostComposer
          venueId={venueId}
          onPosted={() => { setComposing(false); refresh(); }}
          onCancel={() => setComposing(false)}
        />
      ) : (
        <Button variant="pri" onClick={() => setComposing(true)}>＋ New local post</Button>
      )}

      {posts === undefined ? (
        <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
          <div style={{ height: 56, borderRadius: "var(--r-md)", background: "var(--paper-2)" }} />
          <div style={{ height: 56, borderRadius: "var(--r-md)", background: "var(--paper-2)" }} />
        </div>
      ) : posts.length === 0 ? (
        <p style={{ color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.5, margin: "var(--space-3) 2px 0" }}>
          No posts yet. Share news, an offer or an event — it appears on your venue page and in your town&apos;s local news feed.
        </p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-4)" }}>
          {posts.map((p) => (
            <PostManageRow key={p.id} post={p} onChanged={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}

function PostComposer({ venueId, onPosted, onCancel }: { venueId: string; onPosted: () => void; onCancel: () => void }) {
  const trpc = useTrpc();
  const session = useSession();
  const [kind, setKind] = useState<PostKind>("news");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [media, setMedia] = useState<PostMedia[]>([]);
  const [uploading, setUploading] = useState(false);
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    // Mirror core/validateComposition locally for fast feedback (server re-checks).
    if (kind === "offer" && title.trim().length === 0) {
      setErr("An offer needs a title.");
      return;
    }
    if (title.trim().length === 0 && body.trim().length === 0 && media.length === 0) {
      setErr("Add a title, some text or a photo to post.");
      return;
    }
    setBusy(true);
    setErr(null);
    const destinations = notify ? ["profile", "feed", "follower_push"] : ["profile", "feed"];
    const create = trpc.posts.create as unknown as {
      mutate: (i: { venueId: string; kind: PostKind; title?: string; body?: string; media: PostMedia[]; destinations: string[]; isDraft: boolean }) => Promise<CreateResult>;
    };
    try {
      const res = await create.mutate({
        venueId,
        kind,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(body.trim() ? { body: body.trim() } : {}),
        media,
        destinations,
        isDraft: false,
      });
      if (res.created) {
        onPosted();
        return;
      }
      if (res.reason === "insufficient_credits") {
        setErr("Not enough push credits to notify followers. Untick “Notify followers” to post without a push.");
      } else if (res.validation && !res.validation.ok) {
        setErr(res.validation.errors[0] ?? "Couldn't post that.");
      } else {
        setErr("Couldn't post that. Please try again.");
      }
      setBusy(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't post that.");
      setBusy(false);
    }
  }, [trpc, venueId, kind, title, body, media, notify, onPosted]);

  return (
    <Card flat style={{ padding: "var(--space-4)", background: "var(--paper-2)" }}>
      <Seg options={KIND_OPTIONS} value={kind} onChange={(v) => setKind(v as PostKind)} />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={kind === "offer" ? "Offer title — e.g. 2-for-1 cocktails" : "Title (optional)"}
        aria-label="Post title"
        maxLength={200}
        style={inputStyle}
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Tell locals what's happening…"
        aria-label="Post body"
        rows={3}
        style={{ ...inputStyle, resize: "vertical", minHeight: 80 }}
      />
      <MediaPicker
        userId={session?.user?.id ?? null}
        media={media}
        onChange={setMedia}
        uploading={uploading}
        setUploading={setUploading}
        onError={setErr}
      />
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: "var(--space-3)", fontSize: 13.5, color: "var(--ink-2)", cursor: "pointer" }}>
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
        Notify followers (uses 1 push credit)
      </label>
      {err ? <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-2)" }}>{err}</div> : null}
      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
        <Button variant="pri" onClick={() => void submit()} disabled={busy || uploading}>{busy ? "Posting…" : "Post"}</Button>
        <Button variant="neutral" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
      <p style={{ margin: "var(--space-3) 2px 0", fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
        Appears on your venue page and in your town&apos;s local news feed.
      </p>
    </Card>
  );
}

function PostManageRow({ post, onChanged }: { post: ManagedPost; onChanged: () => void }) {
  const trpc = useTrpc();
  const session = useSession();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(post.title ?? "");
  const [body, setBody] = useState(post.body ?? "");
  const [media, setMedia] = useState<PostMedia[]>(post.media);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const state = postState(post);

  const save = useCallback(async () => {
    setBusy(true);
    const mut = trpc.posts.update as unknown as { mutate: (i: { postId: string; title: string | null; body: string | null; media: PostMedia[] }) => Promise<{ ok: true }> };
    try {
      await mut.mutate({ postId: post.id, title: title.trim() || null, body: body.trim() || null, media });
      setEditing(false);
      onChanged();
    } catch {
      /* keep editing */
    } finally {
      setBusy(false);
    }
  }, [trpc, post.id, title, body, media, onChanged]);

  const remove = useCallback(async () => {
    setBusy(true);
    const mut = trpc.posts.remove as unknown as { mutate: (i: { postId: string }) => Promise<{ ok: true }> };
    try {
      await mut.mutate({ postId: post.id });
      onChanged();
    } catch {
      setBusy(false);
      setConfirming(false);
    }
  }, [trpc, post.id, onChanged]);

  return (
    <Card flat style={{ padding: "var(--space-3) var(--space-4)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".05em", textTransform: "uppercase", color: state.live ? "var(--crimson-700)" : "var(--muted)", background: state.live ? "var(--crimson-tint)" : "var(--paper-2)", border: `1px solid ${state.live ? "var(--crimson-tint-2)" : "var(--line)"}`, borderRadius: 999, padding: "2px 8px" }}>
          {state.label}
        </span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--muted)" }}>{post.kind}</span>
        {(post.destinations ?? []).includes("feed") ? <DestBadge>In feed</DestBadge> : null}
        {(post.destinations ?? []).includes("follower_push") ? <DestBadge push>Pushed</DestBadge> : null}
        <span style={{ flex: 1 }} />
        {!editing ? (
          confirming ? (
            <div className={actions.row}>
              <span className={actions.confirm}>Delete?</span>
              <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => void remove()} disabled={busy}>{busy ? "…" : "Yes"}</button>
              <button type="button" className={actions.action} onClick={() => setConfirming(false)} disabled={busy}>No</button>
            </div>
          ) : (
            <div className={actions.row}>
              <button type="button" className={actions.action} onClick={() => setEditing(true)}>Edit</button>
              <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => setConfirming(true)}>Delete</button>
            </div>
          )
        ) : null}
      </div>

      {editing ? (
        <div style={{ marginTop: "var(--space-2)" }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" aria-label="Post title" style={inputStyle} />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Body" aria-label="Post body" rows={3} style={{ ...inputStyle, resize: "vertical", minHeight: 72 }} />
          <MediaPicker userId={session?.user?.id ?? null} media={media} onChange={setMedia} uploading={uploading} setUploading={setUploading} onError={setEditErr} />
          {editErr ? <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-2)" }}>{editErr}</div> : null}
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <Button variant="pri" size="sm" onClick={() => void save()} disabled={busy || uploading || (title.trim().length === 0 && body.trim().length === 0 && media.length === 0)}>{busy ? "Saving…" : "Save"}</Button>
            <Button variant="neutral" size="sm" onClick={() => { setEditing(false); setTitle(post.title ?? ""); setBody(post.body ?? ""); setMedia(post.media); setEditErr(null); }} disabled={busy}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 6 }}>
          {post.title ? <div style={{ fontWeight: 600, fontSize: 14, color: "var(--ink-hi)" }}>{post.title}</div> : null}
          {post.body ? <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.45, marginTop: 2, whiteSpace: "pre-wrap" }}>{post.body}</div> : null}
          {post.media.length > 0 ? <div style={{ marginTop: "var(--space-2)" }}><MediaGrid media={post.media} /></div> : null}
        </div>
      )}
    </Card>
  );
}

/** MediaGrid — render a post's images (1 large, or a tidy 2-col grid for several). */
function MediaGrid({ media }: { media: PostMedia[] }) {
  if (media.length === 0) return null;
  const single = media.length === 1;
  return (
    <div style={{ display: "grid", gridTemplateColumns: single ? "1fr" : "1fr 1fr", gap: 4, borderRadius: "var(--r-md)", overflow: "hidden" }}>
      {media.map((m) => (
        // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
        <img key={m.url} src={m.url} alt="" loading="lazy" style={{ width: "100%", height: single ? "auto" : 140, maxHeight: 420, objectFit: "cover", display: "block", background: "var(--paper-2)" }} />
      ))}
    </div>
  );
}

/**
 * MediaPicker — add/remove up to MAX_POST_IMAGES images for a post. Uploads to the profile-media
 * bucket under the owner's folder (uploadProfileImage kind "post"); stores the public URLs.
 */
function MediaPicker({
  userId,
  media,
  onChange,
  uploading,
  setUploading,
  onError,
}: {
  userId: string | null;
  media: PostMedia[];
  onChange: (m: PostMedia[]) => void;
  uploading: boolean;
  setUploading: (b: boolean) => void;
  onError: (e: string | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);

  const pick = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      if (!userId) { onError("You need to be signed in to add images."); return; }
      const room = MAX_POST_IMAGES - media.length;
      if (room <= 0) return;
      setUploading(true);
      onError(null);
      const next: PostMedia[] = [];
      try {
        for (const file of Array.from(files).slice(0, room)) {
          const { url } = await uploadProfileImage(userId, file, "post");
          next.push({ type: "image", url });
        }
        onChange([...media, ...next]);
      } catch (e) {
        onError(e instanceof Error ? e.message : "Couldn't upload that image.");
      } finally {
        setUploading(false);
      }
    },
    [userId, media, onChange, setUploading, onError],
  );

  return (
    <div style={{ marginTop: "var(--space-3)" }}>
      {media.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
          {media.map((m, i) => (
            <div key={m.url} style={{ position: "relative", width: 76, height: 76, borderRadius: "var(--r-md)", overflow: "hidden", border: "1px solid var(--line)" }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- public bucket URL */}
              <img src={m.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              <button
                type="button"
                aria-label="Remove image"
                onClick={() => onChange(media.filter((_, j) => j !== i))}
                style={{ position: "absolute", top: 3, right: 3, width: 20, height: 20, borderRadius: "50%", border: "none", cursor: "pointer", background: "rgba(33,29,26,.72)", color: "#fff", fontSize: 13, lineHeight: 1, display: "grid", placeItems: "center" }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {media.length < MAX_POST_IMAGES ? (
        <>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            style={{ all: "unset", cursor: uploading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: "var(--crimson-700)" }}
          >
            {uploading ? "Uploading…" : `＋ Add photo${media.length > 0 ? ` (${media.length}/${MAX_POST_IMAGES})` : ""}`}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            style={{ display: "none" }}
            onChange={(e) => { const fs = e.target.files; e.currentTarget.value = ""; void pick(fs); }}
          />
        </>
      ) : null}
    </div>
  );
}
