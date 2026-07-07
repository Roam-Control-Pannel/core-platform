/**
 * ProfileWall — a user's public profile wall (/u/[id]): their header (avatar, name, bio),
 * a composer on their OWN wall, and a feed of posts with likes and comments.
 *
 * Owner-posts / public-view (the product decision): anyone can read; only the wall's owner
 * can post (the API/RLS enforce author_id = self). Liking and commenting need a session,
 * prompted just-in-time. Images upload to the public profile-media bucket (0027) under the
 * owner's folder; native video is a later addition (the media model already tags type).
 *
 * Ships loading / not-found / error / empty / loaded states.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Card, Button, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { ProfileEditor } from "./ProfileEditor";
import { AuthorLink } from "./AuthorLink";
import { AddFriendButton } from "./AddFriendButton";
import { MessageButton } from "./MessageButton";
import { CopyLinkButton } from "./CopyLinkButton";
import { uploadProfileImage, uploadWallVideo } from "../lib/uploadProfileImage";
import { townHallAuthor, timeAgo, type TownHallAuthor } from "../lib/townHall";
import actions from "./inlineActions.module.css";

export interface PublicProfile {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  headerUrl: string | null;
  bio: string | null;
}
interface WallMedia {
  type: "image" | "video";
  url: string;
}
export interface WallPost {
  id: string;
  authorId: string;
  body: string | null;
  media: WallMedia[];
  likeCount: number;
  commentCount: number;
  createdAt: string;
  author: TownHallAuthor;
  viewerLiked: boolean;
}

/**
 * @param editable  when true and the viewer owns this wall, profile editing happens INLINE
 *                  (the header's "Edit profile" toggles a ProfileEditor) instead of linking to
 *                  /account. Used by the "You" surface, which leads with your own wall.
 * @param ownerNav  extra owner controls (e.g. Following / dashboard / sign-out) rendered in the
 *                  header beneath the bio. Only shown to the wall's owner.
 */
export function ProfileWall({
  userId,
  editable = false,
  initialProfile,
}: {
  userId: string;
  editable?: boolean;
  initialProfile?: PublicProfile | null;
}) {
  const trpc = useTrpc();
  const session = useSession();
  const isOwner = session?.user?.id === userId;

  const [profile, setProfile] = useState<PublicProfile | null | undefined>(initialProfile);
  const [posts, setPosts] = useState<WallPost[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const loadProfile = useCallback(async () => {
    const byId = trpc.profiles.byId as unknown as {
      query: (input: { userId: string }) => Promise<PublicProfile | null>;
    };
    return byId.query({ userId });
  }, [trpc, userId]);

  const loadPosts = useCallback(async () => {
    const list = trpc.profileWall.list as unknown as {
      query: (input: { userId: string }) => Promise<{ posts: WallPost[] }>;
    };
    const res = await list.query({ userId });
    return res.posts ?? [];
  }, [trpc, userId]);

  const seeded = initialProfile !== undefined;
  useEffect(() => {
    let cancelled = false;
    // When the server seeded the profile header (SSR), keep it rendered while we refresh; only
    // the unseeded path blanks the header to its skeleton and surfaces a load error. Posts are
    // never seeded, so they always load (and show their own skeleton) on hydration.
    if (!seeded) {
      setProfile(undefined);
      setError(null);
    }
    setPosts(undefined);
    setEditing(false);
    Promise.all([loadProfile(), loadPosts()])
      .then(([p, ps]) => {
        if (cancelled) return;
        setProfile(p);
        setPosts(ps);
      })
      .catch((e: unknown) => {
        if (!cancelled && !seeded) setError(e instanceof Error ? e.message : "Couldn't load this profile.");
      });
    return () => {
      cancelled = true;
    };
  }, [loadProfile, loadPosts, seeded]);

  const reloadProfile = useCallback(() => {
    void loadProfile().then((p) => setProfile(p)).catch(() => {});
  }, [loadProfile]);

  const onPosted = useCallback(() => {
    void loadPosts().then((ps) => setPosts(ps)).catch(() => {});
  }, [loadPosts]);

  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "0 0 var(--space-12)" }}>
      {error ? (
        <div style={{ padding: "var(--space-4)" }}>
          <Card flat style={{ padding: "var(--space-5)", textAlign: "center" }}>
            <p style={{ color: "var(--muted)", margin: 0 }}>{error}</p>
          </Card>
        </div>
      ) : profile === undefined ? (
        <div style={{ padding: "var(--space-4)" }}>
          <div style={{ height: 220, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
        </div>
      ) : profile === null ? (
        <div style={{ padding: "var(--space-4)" }}>
          <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
            <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
              Profile not found
            </div>
            <p style={{ color: "var(--ink-2)", margin: 0 }}>This account may have been removed, or the link is wrong.</p>
          </Card>
        </div>
      ) : (
        <>
          <ProfileHeader
            profile={profile}
            isOwner={isOwner}
            editable={editable}
            editing={editing}
            onToggleEdit={() => setEditing((e) => !e)}
          />
          <div style={{ padding: "0 var(--space-4)" }}>
            {isOwner && editable && editing ? (
              <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
                <ProfileEditor userId={userId} onSaved={reloadProfile} />
                <div style={{ marginTop: "var(--space-3)", textAlign: "right" }}>
                  <Button variant="neutral" size="sm" onClick={() => setEditing(false)}>
                    Done
                  </Button>
                </div>
              </Card>
            ) : null}
            {isOwner ? <WallComposer userId={userId} onPosted={onPosted} /> : null}

            {posts === undefined ? (
              <div style={{ display: "grid", gap: "var(--space-3)" }}>
                {[0, 1].map((i) => (
                  <div key={i} style={{ height: 120, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
                ))}
              </div>
            ) : posts.length === 0 ? (
              <Card style={{ padding: "var(--space-8)", textAlign: "center" }}>
                <span aria-hidden style={{ display: "grid", placeItems: "center", width: 46, height: 46, margin: "0 auto var(--space-3)", borderRadius: 12, background: "var(--paper-2)", color: "var(--muted)" }}>
                  <Icon name="chat" size={20} />
                </span>
                <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: 6 }}>
                  {isOwner ? "Your wall is quiet" : "A quiet wall"}
                </div>
                <p style={{ color: "var(--ink-2)", margin: 0, lineHeight: 1.5, fontSize: 13.5 }}>
                  {isOwner
                    ? "Share your first post, or follow a few venues and friends to fill your feed."
                    : `${profile.displayName ?? "This user"} hasn't posted yet.`}
                </p>
              </Card>
            ) : (
              <div style={{ display: "grid", gap: "var(--space-4)" }}>
                {posts.map((p) => (
                  <PostCard key={p.id} post={p} canInteract={!!session} isOwner={isOwner} myId={session?.user?.id ?? null} onChanged={onPosted} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </main>
  );
}

function ProfileHeader({
  profile,
  isOwner,
  editable,
  editing,
  onToggleEdit,
}: {
  profile: PublicProfile;
  isOwner: boolean;
  editable: boolean;
  editing: boolean;
  onToggleEdit: () => void;
}) {
  return (
    <div style={{ marginBottom: "var(--space-4)", padding: "var(--space-4) var(--space-4) 0" }}>
      {/* Cover photo — a rounded banner card (hi-fi mockup). Owners with no cover yet see the
          quiet mono placeholder label; Edit profile is where they set one. */}
      <div
        style={{
          position: "relative",
          height: 190,
          borderRadius: 22,
          overflow: "hidden",
          background: profile.headerUrl
            ? `center / cover no-repeat url(${profile.headerUrl})`
            : "linear-gradient(120deg, var(--crimson-tint) 0%, var(--paper-2) 55%, var(--crimson-tint-2) 100%)",
        }}
      >
        {isOwner && !profile.headerUrl ? (
          <span style={{ position: "absolute", left: 14, bottom: 10, fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>
            Your cover photo
          </span>
        ) : null}
      </div>

      {/* Identity row: overlapping avatar · name/handle/bio · Share + owner-or-visitor actions. */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-4)", flexWrap: "wrap", padding: "0 var(--space-2)" }}>
        <div style={{ marginTop: -44, position: "relative" }}>
          <Avatar url={profile.avatarUrl} name={townHallAuthor(profileToAuthor(profile))} size={96} ring />
        </div>
        <div style={{ minWidth: 0, flex: 1, paddingTop: "var(--space-3)" }}>
          <h1 className="t-h2" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 26, letterSpacing: "-.015em", margin: 0, lineHeight: 1.15 }}>
            {profile.displayName ?? (profile.handle ? `@${profile.handle}` : "Roam member")}
          </h1>
          {profile.handle ? (
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--muted)", marginTop: 3 }}>@{profile.handle}</div>
          ) : null}
          {profile.bio ? (
            <p style={{ margin: "6px 0 0", color: "var(--ink-2)", lineHeight: 1.5, fontSize: 14, whiteSpace: "pre-wrap" }}>
              {profile.bio}
            </p>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)", paddingTop: "var(--space-3)", flexShrink: 0 }}>
          <CopyLinkButton
            variant="button"
            size="sm"
            path={`/u/${profile.handle ?? profile.id}`}
            title={profile.displayName ?? (profile.handle ? `@${profile.handle}` : "A Roam member")}
          />
          {isOwner ? (
            editable ? (
              <Button variant="dark" size="sm" onClick={onToggleEdit}>
                {editing ? "Close" : "Edit profile"}
              </Button>
            ) : (
              <Link href="/account" style={{ textDecoration: "none" }}>
                <Button variant="dark" size="sm">Edit profile</Button>
              </Link>
            )
          ) : (
            <>
              <MessageButton profileId={profile.id} />
              <AddFriendButton userId={profile.id} />
            </>
          )}
        </div>
      </div>

      {isOwner ? <ProfileStats /> : null}

      {/* Owner tab chips — Wall active (this page), the rest one tap away (mockup nav). */}
      {isOwner ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: "var(--space-4)", padding: "0 var(--space-2)" }}>
          <span style={{ padding: "7px 15px", borderRadius: 999, background: "var(--ink-hi)", color: "#fff", fontFamily: "var(--ui)", fontSize: 13, fontWeight: 600 }}>Wall</span>
          {[
            ["Friends", "/friends"],
            ["Following", "/following"],
            ["Plans", "/plans"],
            ["Orders", "/orders"],
            ["Notifications", "/notifications"],
            ["Business dashboard", "/dashboard"],
            ["Settings", "/settings"],
          ].map(([label, href]) => (
            <Link key={href} href={href!} style={{ padding: "7px 15px", borderRadius: 999, background: "#fff", border: "1px solid var(--line-2)", color: "var(--ink-2)", fontFamily: "var(--ui)", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
              {label}
            </Link>
          ))}
        </div>
      ) : null}

    </div>
  );
}

/** The mockup's stats strip (owner only): Friends · Following · Plans — each cell loads
 *  independently from reads that already exist and simply hides if its read fails. */
function ProfileStats() {
  const trpc = useTrpc();
  const [stats, setStats] = useState<{ label: string; value: number }[]>([]);

  useEffect(() => {
    let cancelled = false;
    const mf = trpc.social.myFriends as unknown as { query: () => Promise<{ friends?: unknown[] }> };
    const fo = trpc.social.myFollows as unknown as { query: () => Promise<{ follows?: unknown[] }> };
    const pl = trpc.plans.list as unknown as { query: () => Promise<{ plans?: unknown[] }> };
    Promise.allSettled([mf.query(), fo.query(), pl.query()]).then(([f, w, p]) => {
      if (cancelled) return;
      const next: { label: string; value: number }[] = [];
      if (f.status === "fulfilled") next.push({ label: "Friends", value: (f.value.friends ?? []).length });
      if (w.status === "fulfilled") next.push({ label: "Following", value: (w.value.follows ?? []).length });
      if (p.status === "fulfilled") next.push({ label: "Plans", value: (p.value.plans ?? []).length });
      setStats(next);
    });
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  if (stats.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: "var(--space-6)", marginTop: "var(--space-4)", padding: "0 var(--space-2)" }}>
      {stats.map((s) => (
        <span key={s.label}>
          <span style={{ display: "block", fontFamily: "var(--display)", fontWeight: 600, fontSize: 20, lineHeight: 1.1, color: "var(--ink-hi)" }}>{s.value}</span>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{s.label}</span>
        </span>
      ))}
    </div>
  );
}

function profileToAuthor(p: PublicProfile): TownHallAuthor {
  return { id: p.id, handle: p.handle, displayName: p.displayName, avatarUrl: p.avatarUrl };
}

function Avatar({ url, name, size, ring }: { url: string | null; name: string; size: number; ring?: boolean }) {
  const common: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
    ...(ring ? { border: "3px solid #fff", boxShadow: "var(--shadow-sm)" } : {}),
  };
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element -- public bucket URL; next/image optimizer adds no value here
    return <img src={url} alt="" style={{ ...common, objectFit: "cover", display: "block" }} />;
  }
  return (
    <span
      aria-hidden
      style={{
        ...common,
        background: "var(--crimson-tint)",
        color: "var(--crimson-700)",
        display: "grid",
        placeItems: "center",
        fontFamily: "var(--display)",
        fontWeight: 700,
        fontSize: size * 0.4,
      }}
    >
      {name.replace(/^@/, "").charAt(0).toUpperCase() || "·"}
    </span>
  );
}

/* ── Composer (owner only) ─────────────────────────────────────────────────────────────── */

const MAX_MEDIA = 4;

function WallComposer({ userId, onPosted }: { userId: string; onPosted: () => void }) {
  const trpc = useTrpc();
  const [body, setBody] = useState("");
  const [media, setMedia] = useState<WallMedia[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLInputElement | null>(null);

  const onPickFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setErr(null);
      const room = MAX_MEDIA - media.length;
      if (room <= 0) {
        setErr(`You can add up to ${MAX_MEDIA} items.`);
        return;
      }
      const chosen = Array.from(files).slice(0, room);
      setUploading(true);
      try {
        const uploaded: WallMedia[] = [];
        for (const file of chosen) {
          const { url } = await uploadProfileImage(userId, file, "wall");
          uploaded.push({ type: "image", url });
        }
        setMedia((m) => [...m, ...uploaded]);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Couldn't upload that image.");
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [userId, media.length],
  );

  const onPickVideo = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      setErr(null);
      if (media.length >= MAX_MEDIA) {
        setErr(`You can add up to ${MAX_MEDIA} items.`);
        return;
      }
      setUploading(true);
      try {
        const { url } = await uploadWallVideo(userId, file);
        setMedia((m) => [...m, { type: "video", url }]);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Couldn't upload that video.");
      } finally {
        setUploading(false);
        if (videoRef.current) videoRef.current.value = "";
      }
    },
    [userId, media.length],
  );

  const submit = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const create = trpc.profileWall.create as unknown as {
      mutate: (input: { body: string | null; media: WallMedia[] }) => Promise<{ id: string }>;
    };
    try {
      await create.mutate({ body: body.trim() ? body : null, media });
      setBody("");
      setMedia([]);
      setBusy(false);
      onPosted();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Couldn't post that.");
      setBusy(false);
    }
  }, [trpc, body, media, onPosted]);

  const canPost = (body.trim().length > 0 || media.length > 0) && !busy && !uploading;

  return (
    <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Share something with your locals…"
        aria-label="Write a post"
        rows={3}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "10px 12px",
          background: "var(--paper-2)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-md)",
          fontFamily: "var(--ui)",
          fontSize: 16,
          color: "var(--ink)",
          outline: "none",
          resize: "vertical",
          minHeight: 76,
        }}
      />

      {media.length > 0 ? (
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-2)" }}>
          {media.map((m) => (
            <div key={m.url} style={{ position: "relative" }}>
              {m.type === "video" ? (
                <video src={m.url} muted playsInline style={{ width: 72, height: 72, objectFit: "cover", borderRadius: "var(--r-md)", display: "block", background: "#000" }} />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- local preview of just-uploaded image
                <img src={m.url} alt="" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: "var(--r-md)", display: "block" }} />
              )}
              <button
                type="button"
                aria-label="Remove media"
                onClick={() => setMedia((cur) => cur.filter((x) => x.url !== m.url))}
                style={{
                  all: "unset", cursor: "pointer", position: "absolute", top: -6, right: -6,
                  width: 20, height: 20, borderRadius: "50%", background: "var(--ink)", color: "#fff",
                  display: "grid", placeItems: "center",
                }}
              >
                <Icon name="close" size={12} aria-label="Remove image" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {err ? (
        <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-2)" }}>
          {err}
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          onChange={(e) => void onPickFiles(e.target.files)}
          style={{ display: "none" }}
        />
        <input
          ref={videoRef}
          type="file"
          accept="video/mp4,video/webm,video/quicktime"
          onChange={(e) => void onPickVideo(e.target.files)}
          style={{ display: "none" }}
        />
        <Button
          variant="neutral"
          size="sm"
          onClick={() => fileRef.current?.click()}
          disabled={uploading || media.length >= MAX_MEDIA}
        >
          {uploading ? "Uploading…" : `＋ Photo${media.length > 0 ? ` (${media.length}/${MAX_MEDIA})` : ""}`}
        </Button>
        <Button
          variant="neutral"
          size="sm"
          onClick={() => videoRef.current?.click()}
          disabled={uploading || media.length >= MAX_MEDIA}
        >
          ＋ Video
        </Button>
        <span style={{ flex: 1 }} />
        <Button variant="pri" size="sm" onClick={() => void submit()} disabled={!canPost}>
          {busy ? "Posting…" : "Post"}
        </Button>
      </div>
    </Card>
  );
}

/* ── Post card ─────────────────────────────────────────────────────────────────────────── */

/** One wall post card — used on the wall itself and standalone on the /p/[postId] permalink. */
export function PostCard({
  post,
  canInteract,
  isOwner,
  myId,
  onChanged,
}: {
  post: WallPost;
  canInteract: boolean;
  isOwner: boolean;
  myId: string | null;
  onChanged: () => void;
}) {
  const trpc = useTrpc();
  const [showComments, setShowComments] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);

  const remove = useCallback(async () => {
    setRemoving(true);
    const del = trpc.profileWall.remove as unknown as { mutate: (i: { postId: string }) => Promise<unknown> };
    try {
      await del.mutate({ postId: post.id });
      onChanged();
    } catch {
      setRemoving(false);
      setConfirming(false);
    }
  }, [trpc, post.id, onChanged]);

  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
        <Avatar url={post.author.avatarUrl} name={townHallAuthor(post.author)} size={32} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <AuthorLink author={post.author} style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }} />
          <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{timeAgo(post.createdAt)}</div>
        </div>
        {isOwner && !editing ? (
          confirming ? (
            <div className={actions.row}>
              <span className={actions.confirm}>Delete?</span>
              <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => void remove()} disabled={removing}>
                {removing ? "Deleting…" : "Yes"}
              </button>
              <button type="button" className={actions.action} onClick={() => setConfirming(false)} disabled={removing}>No</button>
            </div>
          ) : (
            <div className={actions.row}>
              <button type="button" className={actions.action} onClick={() => setEditing(true)} title="Edit post">Edit</button>
              <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => setConfirming(true)} title="Delete post">Delete</button>
            </div>
          )
        ) : null}
      </div>

      {editing ? (
        <PostEditor
          post={post}
          onSaved={() => { setEditing(false); onChanged(); }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          {post.body ? (
            <p style={{ margin: "0 0 var(--space-3)", color: "var(--ink)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{post.body}</p>
          ) : null}

          {post.media.length > 0 ? <MediaGrid media={post.media} /> : null}
        </>
      )}

      {!editing ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", marginTop: "var(--space-3)" }}>
            <LikeButton postId={post.id} initialLiked={post.viewerLiked} initialCount={post.likeCount} canInteract={canInteract} />
            <button
              type="button"
              onClick={() => setShowComments((s) => !s)}
              style={{ all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ink-2)" }}
            >
              <Icon name="chat" size={15} />
              {post.commentCount === 1 ? "1 comment" : `${post.commentCount} comments`}
            </button>
            <CopyLinkButton
              path={`/p/${post.id}`}
              title={`${townHallAuthor(post.author)} on Roam`}
            />
          </div>

          {showComments ? <Comments postId={post.id} canInteract={canInteract} myId={myId} onChanged={onChanged} /> : null}
        </>
      ) : null}
    </Card>
  );
}

/** Inline editor for a wall post — edits the body text; existing media is preserved (resent as-is). */
function PostEditor({ post, onSaved, onCancel }: { post: WallPost; onSaved: () => void; onCancel: () => void }) {
  const trpc = useTrpc();
  const [body, setBody] = useState(post.body ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const mut = trpc.profileWall.update as unknown as {
      mutate: (i: { postId: string; body: string | null; media: WallMedia[] }) => Promise<{ ok: true }>;
    };
    try {
      await mut.mutate({ postId: post.id, body: body.trim() ? body : null, media: post.media });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save your changes.");
      setBusy(false);
    }
  }, [trpc, post.id, post.media, body, onSaved]);

  const canSave = (body.trim().length > 0 || post.media.length > 0) && !busy;

  return (
    <div style={{ marginBottom: "var(--space-2)" }}>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label="Edit post"
        rows={3}
        style={{
          width: "100%", boxSizing: "border-box", padding: "10px 12px", marginBottom: "var(--space-3)",
          background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--r-md)",
          fontFamily: "var(--ui)", fontSize: 16, color: "var(--ink)", outline: "none", resize: "vertical", minHeight: 72,
        }}
      />
      {post.media.length > 0 ? <MediaGrid media={post.media} /> : null}
      {err ? <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, margin: "var(--space-2) 0" }}>{err}</div> : null}
      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
        <Button variant="pri" size="sm" onClick={() => void save()} disabled={!canSave}>{busy ? "Saving…" : "Save"}</Button>
        <Button variant="neutral" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

function MediaGrid({ media }: { media: WallMedia[] }) {
  const cols = media.length === 1 ? 1 : 2;
  const single = media.length === 1;
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 4, borderRadius: "var(--r-md)", overflow: "hidden" }}>
      {media.map((m) =>
        m.type === "video" ? (
          <video
            key={m.url}
            src={m.url}
            controls
            playsInline
            preload="metadata"
            style={{ width: "100%", height: single ? "auto" : 180, maxHeight: 460, objectFit: "cover", display: "block", background: "#000" }}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- public bucket URL; next/image optimizer adds no value
          <img
            key={m.url}
            src={m.url}
            alt=""
            loading="lazy"
            style={{ width: "100%", height: single ? "auto" : 180, maxHeight: 460, objectFit: "cover", display: "block" }}
          />
        ),
      )}
    </div>
  );
}

function LikeButton({
  postId,
  initialLiked,
  initialCount,
  canInteract,
}: {
  postId: string;
  initialLiked: boolean;
  initialCount: number;
  canInteract: boolean;
}) {
  const trpc = useTrpc();
  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);

  const toggle = useCallback(async () => {
    if (!canInteract || busy) return;
    setBusy(true);
    const prevLiked = liked;
    const prevCount = count;
    setLiked(!prevLiked);
    setCount(prevCount + (prevLiked ? -1 : 1));
    const mutate = trpc.profileWall.toggleLike as unknown as {
      mutate: (i: { postId: string }) => Promise<{ liked: boolean; likeCount: number }>;
    };
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
      title={canInteract ? (liked ? "Unlike" : "Like") : "Sign in to like"}
      style={{
        all: "unset",
        cursor: canInteract ? "pointer" : "default",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 13,
        color: liked ? "var(--crimson-700)" : "var(--ink-2)",
      }}
    >
      <span aria-hidden style={{ fontSize: 15 }}>{liked ? "♥" : "♡"}</span>
      {count}
    </button>
  );
}

/* ── Comments ──────────────────────────────────────────────────────────────────────────── */

interface WallComment {
  id: string;
  body: string;
  createdAt: string;
  author: TownHallAuthor;
}

function Comments({ postId, canInteract, myId, onChanged }: { postId: string; canInteract: boolean; myId: string | null; onChanged: () => void }) {
  const trpc = useTrpc();
  const [comments, setComments] = useState<WallComment[] | undefined>(undefined);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const list = trpc.profileWall.listComments as unknown as {
      query: (i: { postId: string }) => Promise<{ comments: WallComment[] }>;
    };
    const res = await list.query({ postId });
    return res.comments ?? [];
  }, [trpc, postId]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((c) => {
        if (!cancelled) setComments(c);
      })
      .catch(() => {
        if (!cancelled) setComments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const submit = useCallback(async () => {
    setBusy(true);
    const add = trpc.profileWall.addComment as unknown as {
      mutate: (i: { postId: string; body: string }) => Promise<{ id: string }>;
    };
    try {
      await add.mutate({ postId, body });
      setBody("");
      const fresh = await load();
      setComments(fresh);
      onChanged(); // refresh the post's comment_count on the parent
    } catch {
      /* keep the text so the user can retry */
    } finally {
      setBusy(false);
    }
  }, [trpc, postId, body, load, onChanged]);

  return (
    <div style={{ marginTop: "var(--space-3)", borderTop: "1px solid var(--line)", paddingTop: "var(--space-3)" }}>
      {comments === undefined ? (
        <div style={{ height: 32, borderRadius: "var(--r-sm)", background: "var(--paper-2)" }} />
      ) : (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {comments.map((c) => (
            <CommentRow
              key={c.id}
              comment={c}
              mine={!!myId && c.author.id === myId}
              onChanged={async () => { const fresh = await load(); setComments(fresh); onChanged(); }}
            />
          ))}
        </div>
      )}

      {canInteract ? (
        <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add a comment…"
            aria-label="Add a comment"
            style={{
              flex: 1, boxSizing: "border-box", padding: "8px 12px", background: "var(--paper-2)",
              border: "1px solid var(--line)", borderRadius: "var(--r-full)", fontFamily: "var(--ui)",
              fontSize: 16, color: "var(--ink)", outline: "none",
            }}
          />
          <Button variant="pri" size="sm" onClick={() => void submit()} disabled={body.trim().length === 0 || busy}>
            {busy ? "…" : "Send"}
          </Button>
        </div>
      ) : (
        <p style={{ margin: "var(--space-3) 0 0", fontSize: 12.5, color: "var(--muted)" }}>
          <Link href="/account" style={{ color: "var(--crimson-700)", textDecoration: "none", fontWeight: 600 }}>Sign in</Link> to like and comment.
        </p>
      )}
    </div>
  );
}

/** A single comment with inline edit / delete for its own author. */
function CommentRow({ comment, mine, onChanged }: { comment: WallComment; mine: boolean; onChanged: () => Promise<void> }) {
  const trpc = useTrpc();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const save = useCallback(async () => {
    setBusy(true);
    const mut = trpc.profileWall.updateComment as unknown as { mutate: (i: { commentId: string; body: string }) => Promise<{ ok: true }> };
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
    const mut = trpc.profileWall.removeComment as unknown as { mutate: (i: { commentId: string }) => Promise<unknown> };
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
      <Avatar url={comment.author.avatarUrl} name={townHallAuthor(comment.author)} size={26} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <AuthorLink author={comment.author} style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }} />
        <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 6 }}>{timeAgo(comment.createdAt)}</span>
        {editing ? (
          <div style={{ marginTop: 4 }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Edit comment"
              rows={2}
              style={{
                width: "100%", boxSizing: "border-box", padding: "8px 12px", background: "var(--paper-2)",
                border: "1px solid var(--line)", borderRadius: "var(--r-md)", fontFamily: "var(--ui)",
                fontSize: 16, color: "var(--ink)", outline: "none", resize: "vertical", minHeight: 56,
              }}
            />
            <div style={{ display: "flex", gap: "var(--space-2)", marginTop: 4 }}>
              <Button variant="pri" size="sm" onClick={() => void save()} disabled={busy || draft.trim().length === 0}>{busy ? "…" : "Save"}</Button>
              <Button variant="neutral" size="sm" onClick={() => { setEditing(false); setDraft(comment.body); }} disabled={busy}>Cancel</Button>
            </div>
          </div>
        ) : (
          <>
            <p style={{ margin: "1px 0 0", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{comment.body}</p>
            {mine ? (
              confirming ? (
                <div className={actions.row} style={{ marginTop: 4 }}>
                  <span className={actions.confirm}>Delete?</span>
                  <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => void remove()} disabled={busy}>{busy ? "…" : "Yes"}</button>
                  <button type="button" className={actions.action} onClick={() => setConfirming(false)} disabled={busy}>No</button>
                </div>
              ) : (
                <div className={actions.row} style={{ marginTop: 4 }}>
                  <button type="button" className={actions.action} onClick={() => setEditing(true)}>Edit</button>
                  <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => setConfirming(true)}>Delete</button>
                </div>
              )
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
