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
import { useTranslations } from "next-intl";
import { Card, Button, Seg } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { PostMediaGrid } from "./PostMediaGrid";
import { uploadProfileImage } from "../lib/uploadProfileImage";
import actions from "./inlineActions.module.css";
import { linkifyHashtags } from "../lib/hashtags";
import { imageFilesFrom, moveItem, thumbButtonStyle } from "../lib/composerMedia";

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

function postState(t: ReturnType<typeof useTranslations>, p: ManagedPost): { label: string; live: boolean } {
  if (p.publishedAt) return { label: t("state.live"), live: true };
  if (p.publishAt) return { label: t("state.scheduled"), live: false };
  return { label: t("state.draft"), live: false };
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
  const t = useTranslations("localPosts");
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
        <Button variant="pri" onClick={() => setComposing(true)}>＋ {t("newLocalPost")}</Button>
      )}

      {posts === undefined ? (
        <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
          <div style={{ height: 56, borderRadius: "var(--r-md)", background: "var(--paper-2)" }} />
          <div style={{ height: 56, borderRadius: "var(--r-md)", background: "var(--paper-2)" }} />
        </div>
      ) : posts.length === 0 ? (
        <p style={{ color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.5, margin: "var(--space-3) 2px 0" }}>
          {t("empty")}
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
  const t = useTranslations("localPosts");
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
      setErr(t("composer.offerNeedsTitle"));
      return;
    }
    if (title.trim().length === 0 && body.trim().length === 0 && media.length === 0) {
      setErr(t("composer.addSomething"));
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
        setErr(t("composer.insufficientCredits"));
      } else if (res.validation && !res.validation.ok) {
        setErr(res.validation.errors[0] ?? t("composer.postFailed"));
      } else {
        setErr(t("composer.postFailedRetry"));
      }
      setBusy(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("composer.postFailed"));
      setBusy(false);
    }
  }, [trpc, venueId, kind, title, body, media, notify, onPosted]);

  return (
    <Card flat style={{ padding: "var(--space-4)", background: "var(--paper-2)" }}>
      <Seg
        options={[
          { value: "news", label: t("kinds.news") },
          { value: "offer", label: t("kinds.offer") },
          { value: "event", label: t("kinds.event") },
        ]}
        value={kind}
        onChange={(v) => setKind(v as PostKind)}
      />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={kind === "offer" ? t("composer.offerTitlePlaceholder") : t("composer.titlePlaceholder")}
        aria-label={t("composer.titleAria")}
        maxLength={200}
        style={inputStyle}
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t("composer.bodyPlaceholder")}
        aria-label={t("composer.bodyAria")}
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
        {t("composer.notifyFollowers")}
      </label>
      {err ? <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-2)" }}>{err}</div> : null}
      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
        <Button variant="pri" onClick={() => void submit()} disabled={busy || uploading}>{busy ? t("composer.posting") : t("composer.post")}</Button>
        <Button variant="neutral" onClick={onCancel} disabled={busy}>{t("composer.cancel")}</Button>
      </div>
      <p style={{ margin: "var(--space-3) 2px 0", fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
        {t("composer.footer")}
      </p>
    </Card>
  );
}

function PostManageRow({ post, onChanged }: { post: ManagedPost; onChanged: () => void }) {
  const t = useTranslations("localPosts");
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
  const state = postState(t, post);

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
        {(post.destinations ?? []).includes("feed") ? <DestBadge>{t("inFeed")}</DestBadge> : null}
        {(post.destinations ?? []).includes("follower_push") ? <DestBadge push>{t("pushed")}</DestBadge> : null}
        <span style={{ flex: 1 }} />
        {!editing ? (
          confirming ? (
            <div className={actions.row}>
              <span className={actions.confirm}>{t("row.deleteConfirm")}</span>
              <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => void remove()} disabled={busy}>{busy ? "…" : t("row.yes")}</button>
              <button type="button" className={actions.action} onClick={() => setConfirming(false)} disabled={busy}>{t("row.no")}</button>
            </div>
          ) : (
            <div className={actions.row}>
              <button type="button" className={actions.action} onClick={() => setEditing(true)}>{t("row.edit")}</button>
              <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => setConfirming(true)}>{t("row.delete")}</button>
            </div>
          )
        ) : null}
      </div>

      {editing ? (
        <div style={{ marginTop: "var(--space-2)" }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("composer.titlePlaceholder")} aria-label={t("composer.titleAria")} style={inputStyle} />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("row.bodyPlaceholder")} aria-label={t("composer.bodyAria")} rows={3} style={{ ...inputStyle, resize: "vertical", minHeight: 72 }} />
          <MediaPicker userId={session?.user?.id ?? null} media={media} onChange={setMedia} uploading={uploading} setUploading={setUploading} onError={setEditErr} />
          {editErr ? <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-2)" }}>{editErr}</div> : null}
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <Button variant="pri" size="sm" onClick={() => void save()} disabled={busy || uploading || (title.trim().length === 0 && body.trim().length === 0 && media.length === 0)}>{busy ? t("row.saving") : t("row.save")}</Button>
            <Button variant="neutral" size="sm" onClick={() => { setEditing(false); setTitle(post.title ?? ""); setBody(post.body ?? ""); setMedia(post.media); setEditErr(null); }} disabled={busy}>{t("composer.cancel")}</Button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 6 }}>
          {post.title ? <div style={{ fontWeight: 600, fontSize: 14, color: "var(--ink-hi)" }}>{post.title}</div> : null}
          {post.body ? <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.45, marginTop: 2, whiteSpace: "pre-wrap" }}>{linkifyHashtags(post.body)}</div> : null}
          {post.media.length > 0 ? <div style={{ marginTop: "var(--space-2)" }}><PostMediaGrid media={post.media} /></div> : null}
        </div>
      )}
    </Card>
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
  const t = useTranslations("localPosts");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [progress, setProgress] = useState<string | null>(null);

  const pick = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || files.length === 0) return;
      if (!userId) { onError(t("media.signInToAdd")); return; }
      const room = MAX_POST_IMAGES - media.length;
      if (room <= 0) return;
      setUploading(true);
      onError(null);
      const next: PostMedia[] = [];
      try {
        const chosen = Array.from(files).slice(0, room);
        for (const [i, file] of chosen.entries()) {
          if (chosen.length > 1) setProgress(t("media.uploadingProgress", { current: i + 1, total: chosen.length }));
          const { url } = await uploadProfileImage(userId, file, "post");
          next.push({ type: "image", url });
        }
        onChange([...media, ...next]);
      } catch (e) {
        onError(e instanceof Error ? e.message : t("media.uploadFailed"));
      } finally {
        setUploading(false);
        setProgress(null);
      }
    },
    [userId, media, onChange, setUploading, onError],
  );

  return (
    <div
      style={{ marginTop: "var(--space-3)" }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => { const fs = imageFilesFrom(e.dataTransfer); if (fs.length > 0) { e.preventDefault(); void pick(fs); } }}
    >
      {media.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
          {media.map((m, i) => (
            <div key={m.url} style={{ position: "relative", width: 76, height: 76, borderRadius: "var(--r-md)", overflow: "hidden", border: "1px solid var(--line)" }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- public bucket URL */}
              <img src={m.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              <button
                type="button"
                aria-label={t("media.removeImage")}
                onClick={() => onChange(media.filter((_, j) => j !== i))}
                style={{ position: "absolute", top: 3, right: 3, width: 20, height: 20, borderRadius: "50%", border: "none", cursor: "pointer", background: "rgba(33,29,26,.72)", color: "#fff", fontSize: 13, lineHeight: 1, display: "grid", placeItems: "center" }}
              >
                ×
              </button>
              {media.length > 1 ? (
                <div style={{ position: "absolute", bottom: 3, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 3 }}>
                  <button type="button" aria-label={t("media.moveEarlier")} disabled={i === 0} onClick={() => onChange(moveItem(media, i, -1))} style={{ ...thumbButtonStyle, opacity: i === 0 ? 0.35 : 1 }}>‹</button>
                  <button type="button" aria-label={t("media.moveLater")} disabled={i === media.length - 1} onClick={() => onChange(moveItem(media, i, 1))} style={{ ...thumbButtonStyle, opacity: i === media.length - 1 ? 0.35 : 1 }}>›</button>
                </div>
              ) : null}
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
            {uploading ? (progress ?? t("media.uploading")) : `＋ ${t("media.addPhoto")}${media.length > 0 ? ` (${media.length}/${MAX_POST_IMAGES})` : ""}`}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            style={{ display: "none" }}
            onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.currentTarget.value = ""; void pick(fs); }}
          />
        </>
      ) : null}
    </div>
  );
}
