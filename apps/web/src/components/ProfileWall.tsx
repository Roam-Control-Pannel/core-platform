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
import { useTranslations } from "next-intl";
import { Card, Button, Icon, type IconName } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { ProfileEditor } from "./ProfileEditor";
import { AuthorLink } from "./AuthorLink";
import { AddFriendButton } from "./AddFriendButton";
import { MessageButton } from "./MessageButton";
import { CopyLinkButton } from "./CopyLinkButton";
import { uploadProfileImage, uploadWallVideo } from "../lib/uploadProfileImage";
import { townHallAuthor, timeAgo, type TownHallAuthor } from "../lib/townHall";
import actions from "./inlineActions.module.css";
import styles from "./ProfileWall.module.css";
import { linkifyHashtags } from "../lib/hashtags";
import { venuePath } from "../lib/routes";
import { imageFilesFrom, moveItem, thumbButtonStyle } from "../lib/composerMedia";

export interface PublicProfile {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  headerUrl: string | null;
  bio: string | null;
  joinedAt?: string | null;
  website?: string | null;
  homeLocality?: string | null;
  verifiedLocal?: boolean;
  wallViews?: number;
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
  location: string | null;
  likeCount: number;
  commentCount: number;
  createdAt: string;
  author: TownHallAuthor;
  viewerLiked: boolean;
}

/* ── Owner-only social data (drives the stat row, the sidebar, and the tab views) ───────────── */
type ProfileView = "wall" | "photos" | "following" | "friends" | "plans";
interface FollowVenue { id: string; name: string; category: string | null; locality: string | null; rating: number | null }
interface FriendLite { id: string; handle: string | null; displayName: string | null; avatarUrl: string | null }
interface PlanLite { id: string; title: string; plannedFor: string | null; headerUrl: string | null }
interface OwnerData { follows: FollowVenue[]; friends: FriendLite[]; plans: PlanLite[] }

/** Profiles already counted as viewed this session (guards SPA re-mount recounts). */
const viewedProfiles = new Set<string>();

/** "1600" → "1.6k", "2400000" → "2.4m". Whole numbers under 1000 stay as-is. */
function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`.replace(".0k", "k");
  return `${(n / 1_000_000).toFixed(1)}m`.replace(".0m", "m");
}

/** Normalise the loose myFollows rows (PostgREST embeds a joined row as object OR array). */
function normalizeFollows(rows: unknown): FollowVenue[] {
  if (!Array.isArray(rows)) return [];
  const out: FollowVenue[] = [];
  for (const r of rows as { venues?: unknown }[]) {
    const v = Array.isArray(r.venues) ? r.venues[0] : r.venues;
    const venue = v as { id?: string; name?: string; category?: string | null; locality?: string | null; rating?: number | null } | null;
    if (venue?.id && venue.name) {
      out.push({ id: venue.id, name: venue.name, category: venue.category ?? null, locality: venue.locality ?? null, rating: typeof venue.rating === "number" ? venue.rating : null });
    }
  }
  return out;
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
  const t = useTranslations("profileWall");
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
        if (!cancelled && !seeded) setError(e instanceof Error ? e.message : t("loadFailed"));
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

  const [view, setView] = useState<ProfileView>("wall");

  // Owner-only social data — the stat counts, the sidebar previews and the tab views all read it.
  // A visitor can't see another person's follows/friends (those reads are caller-scoped), so they
  // get the Wall + Photos tabs and an About-only sidebar.
  const [owner, setOwner] = useState<OwnerData | null>(null);
  useEffect(() => {
    if (!isOwner) { setOwner(null); return; }
    let cancelled = false;
    const fo = trpc.social.myFollows as unknown as { query: () => Promise<{ follows?: unknown[] }> };
    const mf = trpc.social.myFriends as unknown as { query: () => Promise<{ friends?: FriendLite[] }> };
    const pl = trpc.plans.list as unknown as { query: () => Promise<{ plans?: PlanLite[] }> };
    Promise.allSettled([fo.query(), mf.query(), pl.query()]).then(([f, fr, p]) => {
      if (cancelled) return;
      setOwner({
        follows: f.status === "fulfilled" ? normalizeFollows(f.value.follows) : [],
        friends: fr.status === "fulfilled" ? (fr.value.friends ?? []) : [],
        plans: p.status === "fulfilled" ? (p.value.plans ?? []) : [],
      });
    });
    return () => { cancelled = true; };
  }, [trpc, isOwner]);

  // Count a wall view — fire-and-forget, once per profile per session (module-level guard), and
  // never for the owner viewing their own wall. No viewer identity is sent or stored.
  useEffect(() => {
    if (isOwner || viewedProfiles.has(userId)) return;
    viewedProfiles.add(userId);
    const rec = trpc.profiles.recordView as unknown as { mutate: (i: { userId: string }) => Promise<{ ok: boolean }> };
    rec.mutate({ userId }).catch(() => {});
  }, [trpc, userId, isOwner]);

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "0 0 var(--space-12)" }}>
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
              {t("notFoundTitle")}
            </div>
            <p style={{ color: "var(--ink-2)", margin: 0 }}>{t("notFoundBody")}</p>
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
            counts={owner ? { friends: owner.friends.length, following: owner.follows.length, plans: owner.plans.length } : null}
            view={view}
            onView={setView}
          />
          <div style={{ padding: "0 var(--space-4)" }}>
            {isOwner && editable && editing ? (
              <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
                <ProfileEditor userId={userId} onSaved={reloadProfile} />
                <div style={{ marginTop: "var(--space-3)", textAlign: "right" }}>
                  <Button variant="neutral" size="sm" onClick={() => setEditing(false)}>
                    {t("done")}
                  </Button>
                </div>
              </Card>
            ) : null}

            {view === "wall" ? (
              <div className={styles.profileGrid}>
                <div style={{ minWidth: 0, display: "grid", gap: "var(--space-4)" }}>
                  {isOwner ? <WallComposer userId={userId} onPosted={onPosted} /> : null}
                  <WallPosts posts={posts} isOwner={isOwner} displayName={profile.displayName} canInteract={!!session} myId={session?.user?.id ?? null} onChanged={onPosted} />
                </div>
                <ProfileSidebar profile={profile} owner={owner} onView={setView} />
              </div>
            ) : view === "photos" ? (
              <PhotosGrid posts={posts} />
            ) : view === "following" && owner ? (
              <FollowingList follows={owner.follows} />
            ) : view === "friends" && owner ? (
              <FriendsGrid friends={owner.friends} />
            ) : view === "plans" && owner ? (
              <PlansList plans={owner.plans} />
            ) : null}
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
  counts,
  view,
  onView,
}: {
  profile: PublicProfile;
  isOwner: boolean;
  editable: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  counts: { friends: number; following: number; plans: number } | null;
  view: ProfileView;
  onView: (v: ProfileView) => void;
}) {
  const t = useTranslations("profileWall");
  const joinedYear = profile.joinedAt ? new Date(profile.joinedAt).getFullYear() : null;
  const tabs: ProfileView[] = isOwner ? ["wall", "photos", "following", "friends", "plans"] : ["wall", "photos"];
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
        {isOwner ? (
          editable ? (
            <button
              type="button"
              onClick={onToggleEdit}
              style={{ position: "absolute", right: 12, bottom: 12, display: "inline-flex", alignItems: "center", gap: 6, border: "none", cursor: "pointer", fontFamily: "var(--ui)", fontSize: 12.5, fontWeight: 600, color: "var(--ink)", background: "rgba(255,255,255,.9)", backdropFilter: "blur(6px)", borderRadius: 999, padding: "7px 13px" }}
            >
              <Icon name="edit" size={13} /> {t("header.editCover")}
            </button>
          ) : (
            <Link href="/account" style={{ position: "absolute", right: 12, bottom: 12, display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none", fontFamily: "var(--ui)", fontSize: 12.5, fontWeight: 600, color: "var(--ink)", background: "rgba(255,255,255,.9)", backdropFilter: "blur(6px)", borderRadius: 999, padding: "7px 13px" }}>
              <Icon name="edit" size={13} /> {t("header.editCover")}
            </Link>
          )
        ) : null}
      </div>

      {/* Identity row: overlapping avatar · name/handle/bio · Share + owner-or-visitor actions.
          Reflows on mobile (see .identityRow in the module) so the actions never squeeze the name. */}
      <div className={styles.identityRow}>
        <div style={{ marginTop: -44, position: "relative", flexShrink: 0 }}>
          <Avatar url={profile.avatarUrl} name={townHallAuthor(profileToAuthor(profile))} size={96} ring />
        </div>
        <div className={styles.identityMain}>
          <h1 className="t-h2" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 26, letterSpacing: "-.015em", margin: 0, lineHeight: 1.15 }}>
            {profile.displayName ?? (profile.handle ? `@${profile.handle}` : t("header.roamMember"))}
          </h1>
          {profile.handle ? (
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--muted)", marginTop: 3 }}>@{profile.handle}</div>
          ) : null}
          {profile.bio ? (
            <p style={{ margin: "6px 0 0", color: "var(--ink-2)", lineHeight: 1.5, fontSize: 14, whiteSpace: "pre-wrap" }}>
              {linkifyHashtags(profile.bio)}
            </p>
          ) : null}
          {profile.homeLocality || joinedYear || profile.verifiedLocal ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: "var(--space-3)" }}>
              {profile.homeLocality ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: "var(--crimson-700)", background: "var(--crimson-tint)", border: "1px solid var(--crimson-tint)", borderRadius: 999, padding: "4px 11px" }}>
                  <Icon name="place" size={13} /> {profile.homeLocality}
                </span>
              ) : null}
              {joinedYear ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)", background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: 999, padding: "4px 11px" }}>
                  <Icon name="clock" size={13} /> {t("header.joinedYear", { year: joinedYear })}
                </span>
              ) : null}
              {profile.verifiedLocal ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)", background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: 999, padding: "4px 11px" }}>
                  <Icon name="check" size={13} style={{ color: "var(--success, #2ea056)" }} /> {t("header.verifiedLocal")}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className={styles.identityActions}>
          <CopyLinkButton
            variant="button"
            size="sm"
            path={`/u/${profile.handle ?? profile.id}`}
            title={profile.displayName ?? (profile.handle ? `@${profile.handle}` : t("header.aRoamMember"))}
          />
          {isOwner ? (
            editable ? (
              <Button variant="dark" size="sm" onClick={onToggleEdit}>
                {editing ? t("header.close") : t("header.editProfile")}
              </Button>
            ) : (
              <Link href="/account" style={{ textDecoration: "none" }}>
                <Button variant="dark" size="sm">{t("header.editProfile")}</Button>
              </Link>
            )
          ) : (
            <>
              <MessageButton profileId={profile.id} />
              <AddFriendButton userId={profile.id} />
            </>
          )}
          {isOwner ? <OverflowMenu /> : null}
        </div>
      </div>

      {(isOwner && counts) || profile.wallViews != null ? (
        <div style={{ display: "flex", gap: "var(--space-6)", marginTop: "var(--space-4)", padding: "0 var(--space-2)", flexWrap: "wrap" }}>
          {isOwner && counts ? (
            <>
              <StatCell value={compactNumber(counts.friends)} label={t("stats.friends")} />
              <StatCell value={compactNumber(counts.following)} label={t("stats.following")} />
              <StatCell value={compactNumber(counts.plans)} label={t("stats.plans")} />
            </>
          ) : null}
          {profile.wallViews != null ? <StatCell value={compactNumber(profile.wallViews)} label={t("stats.wallViews")} /> : null}
        </div>
      ) : null}

      {/* Underline tabs — a client view switch (Wall · Photos, plus the owner's Following · Friends
          · Plans). */}
      <div className={styles.tabbar} style={{ marginTop: "var(--space-4)" }} role="tablist">
        {tabs.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => onView(v)}
            className={`${styles.tab} ${view === v ? styles.tabActive : ""}`}
          >
            {t(`header.tabs.${v}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

function StatCell({ value, label }: { value: string; label: string }) {
  return (
    <span>
      <span style={{ display: "block", fontFamily: "var(--display)", fontWeight: 600, fontSize: 20, lineHeight: 1.1, color: "var(--ink-hi)" }}>{value}</span>
      <span style={{ fontSize: 12, color: "var(--muted)" }}>{label}</span>
    </span>
  );
}

/** The "…" overflow — owner quick-nav (settings · notifications · orders), outside-click to close. */
function OverflowMenu() {
  const t = useTranslations("profileWall");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const items: [string, string][] = [
    ["/settings", t("header.menu.settings")],
    ["/notifications", t("header.menu.notifications")],
    ["/orders", t("header.menu.orders")],
  ];
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        aria-label={t("header.menu.more")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ all: "unset", cursor: "pointer", width: 38, height: 38, borderRadius: 999, border: "1px solid var(--line-2)", display: "grid", placeItems: "center", background: "#fff", color: "var(--ink-2)", boxSizing: "border-box" }}
      >
        <span aria-hidden style={{ fontSize: 20, lineHeight: 1, letterSpacing: 1 }}>···</span>
      </button>
      {open ? (
        <div role="menu" style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", background: "#fff", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "var(--shadow-pop)", padding: 6, minWidth: 190, zIndex: 20 }}>
          {items.map(([href, label]) => (
            <Link key={href} href={href} onClick={() => setOpen(false)} style={{ display: "block", padding: "9px 11px", borderRadius: 8, fontSize: 13.5, fontWeight: 600, color: "var(--ink)", textDecoration: "none" }}>{label}</Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ── Wall posts (the feed), extracted so the "wall" view and its states are one component ─────── */
function WallPosts({
  posts,
  isOwner,
  displayName,
  canInteract,
  myId,
  onChanged,
}: {
  posts: WallPost[] | undefined;
  isOwner: boolean;
  displayName: string | null;
  canInteract: boolean;
  myId: string | null;
  onChanged: () => void;
}) {
  const t = useTranslations("profileWall");
  if (posts === undefined) {
    return (
      <div style={{ display: "grid", gap: "var(--space-3)" }}>
        {[0, 1].map((i) => (
          <div key={i} style={{ height: 120, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
        ))}
      </div>
    );
  }
  if (posts.length === 0) {
    return (
      <Card style={{ padding: "var(--space-8)", textAlign: "center" }}>
        <span aria-hidden style={{ display: "grid", placeItems: "center", width: 46, height: 46, margin: "0 auto var(--space-3)", borderRadius: 12, background: "var(--paper-2)", color: "var(--muted)" }}>
          <Icon name="chat" size={20} />
        </span>
        <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: 6 }}>
          {isOwner ? t("empty.ownerTitle") : t("empty.visitorTitle")}
        </div>
        <p style={{ color: "var(--ink-2)", margin: 0, lineHeight: 1.5, fontSize: 13.5 }}>
          {isOwner ? t("empty.ownerBody") : t("empty.visitorBody", { name: displayName ?? t("empty.thisUser") })}
        </p>
      </Card>
    );
  }
  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      {posts.map((p) => (
        <PostCard key={p.id} post={p} canInteract={canInteract} isOwner={isOwner} myId={myId} onChanged={onChanged} />
      ))}
    </div>
  );
}

/** The sticky right column on the Wall view: About + Following/Friends previews (owner only). */
function ProfileSidebar({ profile, owner, onView }: { profile: PublicProfile; owner: OwnerData | null; onView: (v: ProfileView) => void }) {
  const t = useTranslations("profileWall");
  const joined = profile.joinedAt
    ? new Date(profile.joinedAt).toLocaleDateString(undefined, { month: "long", year: "numeric" })
    : null;
  let host: string | null = null;
  if (profile.website) {
    try { host = new URL(profile.website).hostname.replace(/^www\./, ""); } catch { host = profile.website; }
  }
  const card: React.CSSProperties = { border: "1px solid var(--line)", borderRadius: 16, padding: "var(--space-4)", background: "var(--paper)" };
  const cardTitle: React.CSSProperties = { fontWeight: 700, fontSize: 14, marginBottom: "var(--space-3)" };

  return (
    <aside className={styles.sidebar}>
      {profile.homeLocality || joined || host ? (
        <div style={card}>
          <div style={cardTitle}>{t("sidebar.about")}</div>
          <div style={{ display: "grid", gap: "var(--space-2)", fontSize: 13.5, color: "var(--ink-2)" }}>
            {profile.homeLocality ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="place" size={14} style={{ color: "var(--muted)" }} /> {t("sidebar.livesIn", { place: profile.homeLocality })}
              </div>
            ) : null}
            {joined ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="clock" size={14} style={{ color: "var(--muted)" }} /> {t("sidebar.joined", { date: joined })}
              </div>
            ) : null}
            {host ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <Icon name="link" size={14} style={{ color: "var(--muted)" }} />
                <a href={profile.website!} target="_blank" rel="noopener noreferrer nofollow" style={{ color: "var(--crimson-700)", textDecoration: "none", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{host}</a>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {owner && owner.follows.length > 0 ? (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{t("sidebar.following")}</span>
            <button type="button" onClick={() => onView("following")} style={{ all: "unset", cursor: "pointer", fontSize: 12.5, fontWeight: 600, color: "var(--crimson-700)" }}>{t("sidebar.seeAll", { count: owner.follows.length })}</button>
          </div>
          <div style={{ display: "grid", gap: "var(--space-3)" }}>
            {owner.follows.slice(0, 3).map((v) => <MiniVenue key={v.id} venue={v} />)}
          </div>
        </div>
      ) : null}

      {owner && owner.friends.length > 0 ? (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{t("sidebar.friendsCount", { count: owner.friends.length })}</span>
            <button type="button" onClick={() => onView("friends")} style={{ all: "unset", cursor: "pointer", fontSize: 12.5, fontWeight: 600, color: "var(--crimson-700)" }}>{t("sidebar.seeAllShort")}</button>
          </div>
          <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
            {owner.friends.slice(0, 4).map((f) => (
              <Link key={f.id} href={`/u/${f.handle ?? f.id}`} style={{ textDecoration: "none", textAlign: "center", width: 56 }}>
                <Avatar url={f.avatarUrl} name={f.displayName ?? f.handle ?? "·"} size={48} />
                <div style={{ fontSize: 11.5, color: "var(--ink-2)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(f.displayName ?? f.handle ?? "").split(" ")[0]}</div>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </aside>
  );
}

/** A single followed-venue row (name · category · ★rating), links to the venue. */
function MiniVenue({ venue }: { venue: FollowVenue }) {
  return (
    <Link href={venuePath(venue.id)} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", textDecoration: "none", color: "inherit", minWidth: 0 }}>
      <span aria-hidden style={{ width: 38, height: 38, borderRadius: 10, background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", flexShrink: 0 }}>
        <Icon name="place" size={17} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{venue.name}</span>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>{[venue.category, venue.locality].filter(Boolean).join(" · ")}</span>
      </span>
      {venue.rating != null ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 12.5, fontWeight: 700, color: "var(--ink-2)", flexShrink: 0 }}>
          <Icon name="star" size={12} style={{ color: "var(--gold, #e0a855)" }} /> {venue.rating.toFixed(1)}
        </span>
      ) : null}
    </Link>
  );
}

/* ── Tab views (full-width, shown when their tab is active) ──────────────────────────────────── */

function PhotosGrid({ posts }: { posts: WallPost[] | undefined }) {
  const t = useTranslations("profileWall");
  const media = (posts ?? []).flatMap((p) => p.media.filter((m) => m.type === "image").map((m) => ({ url: m.url, postId: p.id })));
  if (posts === undefined) return <div style={{ height: 160, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />;
  if (media.length === 0) return <EmptyView icon="photo" text={t("views.noPhotos")} />;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "var(--space-2)" }}>
      {media.map((m, i) => (
        // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
        <img key={`${m.postId}-${i}`} src={m.url} alt="" style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 12, display: "block", background: "var(--paper-2)" }} />
      ))}
    </div>
  );
}

function FollowingList({ follows }: { follows: FollowVenue[] }) {
  const t = useTranslations("profileWall");
  if (follows.length === 0) return <EmptyView icon="heart" text={t("views.noFollowing")} />;
  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }}>
      {follows.map((v) => (
        <Card key={v.id} style={{ padding: "var(--space-3) var(--space-4)" }}><MiniVenue venue={v} /></Card>
      ))}
    </div>
  );
}

function FriendsGrid({ friends }: { friends: FriendLite[] }) {
  const t = useTranslations("profileWall");
  if (friends.length === 0) return <EmptyView icon="users" text={t("views.noFriends")} />;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: "var(--space-3)" }}>
      {friends.map((f) => (
        <Link key={f.id} href={`/u/${f.handle ?? f.id}`} style={{ textDecoration: "none", color: "inherit" }}>
          <Card style={{ padding: "var(--space-4)", textAlign: "center" }}>
            <div style={{ display: "grid", placeItems: "center" }}><Avatar url={f.avatarUrl} name={f.displayName ?? f.handle ?? "·"} size={64} /></div>
            <div style={{ marginTop: "var(--space-2)", fontSize: 13.5, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.displayName ?? (f.handle ? `@${f.handle}` : "")}</div>
            {f.handle ? <div style={{ fontSize: 12, color: "var(--muted)" }}>@{f.handle}</div> : null}
          </Card>
        </Link>
      ))}
    </div>
  );
}

function PlansList({ plans }: { plans: PlanLite[] }) {
  const t = useTranslations("profileWall");
  if (plans.length === 0) return <EmptyView icon="plan" text={t("views.noPlans")} />;
  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }}>
      {plans.map((p) => (
        <Link key={p.id} href={`/plans/${p.id}`} style={{ textDecoration: "none", color: "inherit" }}>
          <Card style={{ padding: "var(--space-3) var(--space-4)", display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            <span aria-hidden style={{ width: 40, height: 40, borderRadius: 10, background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", flexShrink: 0 }}><Icon name="plan" size={18} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontFamily: "var(--display)", fontWeight: 600, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
              {p.plannedFor ? <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{new Date(p.plannedFor).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</span> : null}
            </span>
            <span aria-hidden style={{ color: "var(--muted)" }}>→</span>
          </Card>
        </Link>
      ))}
    </div>
  );
}

function EmptyView({ icon, text }: { icon: IconName; text: string }) {
  return (
    <Card style={{ padding: "var(--space-8)", textAlign: "center" }}>
      <span aria-hidden style={{ display: "grid", placeItems: "center", width: 46, height: 46, margin: "0 auto var(--space-3)", borderRadius: 12, background: "var(--paper-2)", color: "var(--muted)" }}>
        <Icon name={icon} size={20} />
      </span>
      <p style={{ color: "var(--ink-2)", margin: 0, lineHeight: 1.5, fontSize: 13.5 }}>{text}</p>
    </Card>
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
  const t = useTranslations("profileWall");
  const trpc = useTrpc();
  const [body, setBody] = useState("");
  const [media, setMedia] = useState<WallMedia[]>([]);
  const [location, setLocation] = useState("");
  const [checkingIn, setCheckingIn] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLInputElement | null>(null);
  const locationRef = useRef<HTMLInputElement | null>(null);

  const [progress, setProgress] = useState<string | null>(null);

  const onPickFiles = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || files.length === 0) return;
      setErr(null);
      const room = MAX_MEDIA - media.length;
      if (room <= 0) {
        setErr(t("composer.maxItems", { max: MAX_MEDIA }));
        return;
      }
      const chosen = Array.from(files).slice(0, room);
      setUploading(true);
      try {
        const uploaded: WallMedia[] = [];
        for (const [i, file] of chosen.entries()) {
          if (chosen.length > 1) setProgress(t("composer.uploadingProgress", { current: i + 1, total: chosen.length }));
          const { url } = await uploadProfileImage(userId, file, "wall");
          uploaded.push({ type: "image", url });
        }
        setMedia((m) => [...m, ...uploaded]);
      } catch (e) {
        setErr(e instanceof Error ? e.message : t("composer.uploadImageFailed"));
      } finally {
        setUploading(false);
        setProgress(null);
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
        setErr(t("composer.maxItems", { max: MAX_MEDIA }));
        return;
      }
      setUploading(true);
      try {
        const { url } = await uploadWallVideo(userId, file);
        setMedia((m) => [...m, { type: "video", url }]);
      } catch (e) {
        setErr(e instanceof Error ? e.message : t("composer.uploadVideoFailed"));
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
      mutate: (input: { body: string | null; media: WallMedia[]; location: string | null }) => Promise<{ id: string }>;
    };
    try {
      await create.mutate({ body: body.trim() ? body : null, media, location: location.trim() ? location.trim() : null });
      setBody("");
      setMedia([]);
      setLocation("");
      setCheckingIn(false);
      setBusy(false);
      onPosted();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t("composer.postFailed"));
      setBusy(false);
    }
  }, [trpc, body, media, location, onPosted]);

  const canPost = (body.trim().length > 0 || media.length > 0 || location.trim().length > 0) && !busy && !uploading;

  return (
    <Card
      style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => { const fs = imageFilesFrom(e.dataTransfer); if (fs.length > 0) { e.preventDefault(); void onPickFiles(fs); } }}
    >
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onPaste={(e) => { const fs = imageFilesFrom(e.clipboardData); if (fs.length > 0) { e.preventDefault(); void onPickFiles(fs); } }}
        placeholder={t("composer.placeholder")}
        aria-label={t("composer.writeAria")}
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
          {media.map((m, i) => (
            <div key={m.url} style={{ position: "relative" }}>
              {media.length > 1 ? (
                <div style={{ position: "absolute", bottom: -6, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 3, zIndex: 1 }}>
                  <button type="button" aria-label={t("composer.moveEarlier")} disabled={i === 0} onClick={() => setMedia((cur) => moveItem(cur, i, -1))} style={{ ...thumbButtonStyle, opacity: i === 0 ? 0.35 : 1 }}>‹</button>
                  <button type="button" aria-label={t("composer.moveLater")} disabled={i === media.length - 1} onClick={() => setMedia((cur) => moveItem(cur, i, 1))} style={{ ...thumbButtonStyle, opacity: i === media.length - 1 ? 0.35 : 1 }}>›</button>
                </div>
              ) : null}
              {m.type === "video" ? (
                <video src={m.url} muted playsInline style={{ width: 72, height: 72, objectFit: "cover", borderRadius: "var(--r-md)", display: "block", background: "#000" }} />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- local preview of just-uploaded image
                <img src={m.url} alt="" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: "var(--r-md)", display: "block" }} />
              )}
              <button
                type="button"
                aria-label={t("composer.removeMedia")}
                onClick={() => setMedia((cur) => cur.filter((x) => x.url !== m.url))}
                style={{
                  all: "unset", cursor: "pointer", position: "absolute", top: -6, right: -6,
                  width: 20, height: 20, borderRadius: "50%", background: "var(--ink)", color: "#fff",
                  display: "grid", placeItems: "center",
                }}
              >
                <Icon name="close" size={12} aria-label={t("composer.removeImage")} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {checkingIn ? (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-2)", padding: "8px 12px", background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--r-md)" }}>
          <Icon name="place" size={15} style={{ color: "var(--crimson-700)", flexShrink: 0 }} />
          <input
            ref={locationRef}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder={t("composer.checkInPlaceholder")}
            aria-label={t("composer.checkInAria")}
            maxLength={120}
            style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", fontFamily: "var(--ui)", fontSize: 15, color: "var(--ink)", outline: "none" }}
          />
          <button
            type="button"
            aria-label={t("composer.checkInClear")}
            onClick={() => { setLocation(""); setCheckingIn(false); }}
            style={{ all: "unset", cursor: "pointer", display: "grid", placeItems: "center", width: 22, height: 22, borderRadius: "50%", color: "var(--muted)", flexShrink: 0 }}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ) : null}

      {err ? (
        <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-2)" }}>
          {err}
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-2)", rowGap: "var(--space-2)", marginTop: "var(--space-3)" }}>
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
          {uploading
            ? (progress ?? t("composer.uploading"))
            : media.length > 0
              ? t("composer.addPhotoCount", { count: media.length, max: MAX_MEDIA })
              : t("composer.addPhoto")}
        </Button>
        <Button
          variant="neutral"
          size="sm"
          onClick={() => videoRef.current?.click()}
          disabled={uploading || media.length >= MAX_MEDIA}
        >
          {t("composer.addVideo")}
        </Button>
        <Button
          variant={checkingIn || location.trim() ? "pri" : "neutral"}
          size="sm"
          onClick={() => {
            setCheckingIn(true);
            setTimeout(() => locationRef.current?.focus(), 0);
          }}
        >
          <Icon name="place" size={14} /> {t("composer.checkIn")}
        </Button>
        <Button variant="pri" size="sm" onClick={() => void submit()} disabled={!canPost} style={{ marginLeft: "auto" }}>
          {busy ? t("composer.posting") : t("composer.post")}
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
  const t = useTranslations("profileWall");
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
          <div style={{ fontSize: 11.5, color: "var(--muted)", display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
            <span>{timeAgo(post.createdAt)}</span>
            {post.location ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--crimson-700)", fontWeight: 600 }}>
                <span aria-hidden>·</span>
                <Icon name="place" size={12} /> {post.location}
              </span>
            ) : null}
          </div>
        </div>
        {isOwner && !editing ? (
          confirming ? (
            <div className={actions.row}>
              <span className={actions.confirm}>{t("post.deleteConfirm")}</span>
              <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => void remove()} disabled={removing}>
                {removing ? t("post.deleting") : t("post.yes")}
              </button>
              <button type="button" className={actions.action} onClick={() => setConfirming(false)} disabled={removing}>{t("post.no")}</button>
            </div>
          ) : (
            <div className={actions.row}>
              <button type="button" className={actions.action} onClick={() => setEditing(true)} title={t("post.editPost")}>{t("post.edit")}</button>
              <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => setConfirming(true)} title={t("post.deletePost")}>{t("post.delete")}</button>
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
            <p style={{ margin: "0 0 var(--space-3)", color: "var(--ink)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{linkifyHashtags(post.body)}</p>
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
              {t("post.comments", { count: post.commentCount })}
            </button>
            <CopyLinkButton
              path={`/p/${post.id}`}
              title={t("post.shareTitle", { name: townHallAuthor(post.author) })}
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
  const t = useTranslations("profileWall");
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
      setErr(e instanceof Error ? e.message : t("editor.saveFailed"));
      setBusy(false);
    }
  }, [trpc, post.id, post.media, body, onSaved]);

  const canSave = (body.trim().length > 0 || post.media.length > 0) && !busy;

  return (
    <div style={{ marginBottom: "var(--space-2)" }}>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label={t("editor.editPostAria")}
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
        <Button variant="pri" size="sm" onClick={() => void save()} disabled={!canSave}>{busy ? t("editor.saving") : t("editor.save")}</Button>
        <Button variant="neutral" size="sm" onClick={onCancel} disabled={busy}>{t("editor.cancel")}</Button>
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
  const t = useTranslations("profileWall");
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
      title={canInteract ? (liked ? t("like.unlike") : t("like.like")) : t("like.signInToLike")}
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
  const t = useTranslations("profileWall");
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
            placeholder={t("comments.placeholder")}
            aria-label={t("comments.addAria")}
            style={{
              flex: 1, boxSizing: "border-box", padding: "8px 12px", background: "var(--paper-2)",
              border: "1px solid var(--line)", borderRadius: "var(--r-full)", fontFamily: "var(--ui)",
              fontSize: 16, color: "var(--ink)", outline: "none",
            }}
          />
          <Button variant="pri" size="sm" onClick={() => void submit()} disabled={body.trim().length === 0 || busy}>
            {busy ? "…" : t("comments.send")}
          </Button>
        </div>
      ) : (
        <p style={{ margin: "var(--space-3) 0 0", fontSize: 12.5, color: "var(--muted)" }}>
          {t.rich("comments.signInToInteract", {
            link: (chunks) => (
              <Link href="/account" style={{ color: "var(--crimson-700)", textDecoration: "none", fontWeight: 600 }}>{chunks}</Link>
            ),
          })}
        </p>
      )}
    </div>
  );
}

/** A single comment with inline edit / delete for its own author. */
function CommentRow({ comment, mine, onChanged }: { comment: WallComment; mine: boolean; onChanged: () => Promise<void> }) {
  const t = useTranslations("profileWall");
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
              aria-label={t("comment.editAria")}
              rows={2}
              style={{
                width: "100%", boxSizing: "border-box", padding: "8px 12px", background: "var(--paper-2)",
                border: "1px solid var(--line)", borderRadius: "var(--r-md)", fontFamily: "var(--ui)",
                fontSize: 16, color: "var(--ink)", outline: "none", resize: "vertical", minHeight: 56,
              }}
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
