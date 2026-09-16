/**
 * HomeFeed — the Home wall's main column: one scrollable local feed mixing rich business
 * post cards with Forum topic cards, filtered by a Seg. Ported from web's HomeFeed.tsx.
 *
 *   For you    — geofenced business posts interleaved with the town's hot topics and, when
 *                signed in, the viewer's own and their friends' wall posts.
 *   Following  — posts from venues the viewer follows (sign-in nudge when signed out).
 *   Nearby     — geofenced business posts only.
 *
 * Reads the SAME procedures web does (posts.feed, townHall.listTopics, social.myFollows,
 * profileWall.friendsFeed), so the two surfaces show the same feed for the same place. One
 * fetch per source per place; the tabs are client-side views over what's already loaded,
 * which is why switching them is instant.
 *
 * Rendered inside the screen's ScrollView as a plain column rather than a FlatList: the
 * feed is a bounded page (20 posts, 6 topics), and nesting a virtualised list inside a
 * scroll view breaks both. Pagination would change that, and is a later slice.
 *
 * Every source degrades independently — topics failing leaves a posts-only feed, and a
 * failed posts read shows a note rather than blanking the page.
 */
import { useMemo, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { color, space } from "@roam/design/tokens";
import { Card, Button, Seg, Icon, family, text } from "../../design";
import { useTrpc, useSession } from "../../lib/TrpcProvider";
import type { Place } from "../../lib/useCurrentPlace";
import { useAuthPrompt } from "../AuthPrompt";
import {
  PostFeedCard,
  TopicFeedCard,
  WallPostCard,
  type FeedPost,
  type FeedTopic,
  type WallPost,
} from "./FeedCards";

type Tab = "foryou" | "following" | "nearby";

const TABS = [
  { value: "foryou" as const, label: "For you" },
  { value: "following" as const, label: "Following" },
  { value: "nearby" as const, label: "Nearby" },
];

const FOLLOWING_NUDGE =
  "Sign in and follow your favourite local businesses — their news, offers and events land here.";

/** An ISO timestamp as a sortable number; unparseable/missing sorts oldest. */
function ts(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export function HomeFeed({ place }: { place: Place }) {
  const trpc = useTrpc();
  const session = useSession();
  const signedIn = !!session;
  const [tab, setTab] = useState<Tab>("foryou");

  // The geofenced local feed — the product rule is that a business posts into its own
  // town's feed, so the place centre is the query, not a filter applied after.
  const posts = useQuery({
    queryKey: ["posts.feed", place.lat, place.lng],
    queryFn: () => trpc.posts.feed.query({ limit: 20, lat: place.lat, lng: place.lng }),
  });

  // Topics are ADDITIVE to the feed: a failure here must leave a posts-only feed, never an
  // error state, so this query's error is deliberately never surfaced.
  const topics = useQuery({
    queryKey: ["townHall.listTopics", place.name],
    queryFn: () => trpc.townHall.listTopics.query({ localityName: place.name, sort: "hot" }),
  });

  const follows = useQuery({
    queryKey: ["social.myFollows"],
    queryFn: () => trpc.social.myFollows.query(),
    enabled: signedIn,
  });

  // The social half of "For you": the viewer's own posts plus their friends'. Signed-in only,
  // and additive like topics — if it fails, the feed is simply venues and topics.
  const wall = useQuery({
    queryKey: ["profileWall.friendsFeed"],
    queryFn: () => trpc.profileWall.friendsFeed.query({ limit: 20 }),
    enabled: signedIn,
  });

  const localPosts = (posts.data ?? []) as FeedPost[];
  const hotTopics = useMemo(
    () => ((topics.data?.topics ?? []) as FeedTopic[]).slice(0, 6),
    [topics.data],
  );

  // Nothing local at all → we show the pioneer banner, and keep the page alive underneath
  // with network-wide activity. Only fetched once we KNOW the local feed is empty, so the
  // common case never pays for it.
  const wallPosts = (wall.data?.posts ?? []) as WallPost[];

  // Only "empty" once every local source has actually reported — otherwise a slow topics or
  // wall read would briefly look like a dead town and trigger the global fetch for nothing.
  const localEmpty =
    posts.isSuccess &&
    !topics.isPending &&
    (!signedIn || !wall.isPending) &&
    localPosts.length === 0 &&
    hotTopics.length === 0 &&
    wallPosts.length === 0;
  const globalPosts = useQuery({
    queryKey: ["posts.feed", "global"],
    queryFn: () => trpc.posts.feed.query({ limit: 8 }),
    enabled: localEmpty,
  });

  const followedIds = useMemo(() => {
    const rows = follows.data?.ok ? (follows.data.follows ?? []) : [];
    return new Set(rows.map((f) => f.venue_id));
  }, [follows.data]);

  /** The cards for the active tab, newest first. */
  const items = useMemo(() => {
    const visiblePosts =
      tab === "following" ? localPosts.filter((p) => followedIds.has(p.venueId)) : localPosts;
    const postCards = visiblePosts.map((p) => ({
      key: `post-${p.id}`,
      at: ts(p.publishedAt),
      node: <PostFeedCard post={p} />,
    }));

    if (tab !== "foryou") return postCards.sort((a, b) => b.at - a.at);
    // For you: business posts, hot topics and wall posts in one stream, ordered by recency.
    const topicCards = hotTopics.map((t) => ({
      key: `topic-${t.id}`,
      at: ts(t.lastActivityAt ?? t.createdAt),
      node: <TopicFeedCard topic={t} />,
    }));
    const wallCards = wallPosts.map((p) => ({
      key: `wall-${p.id}`,
      at: ts(p.createdAt),
      node: <WallPostCard post={p} />,
    }));
    return [...postCards, ...topicCards, ...wallCards].sort((a, b) => b.at - a.at);
  }, [tab, localPosts, hotTopics, wallPosts, followedIds]);

  // The "For you" stream isn't complete until its additive sources land, so hold the
  // skeletons rather than reflowing the column a moment after it paints.
  const loading =
    posts.isPending ||
    (tab === "foryou" && (topics.isPending || (signedIn && wall.isPending))) ||
    (tab === "following" && signedIn && follows.isPending);

  return (
    <View>
      <View style={styles.header}>
        <Text style={styles.title}>Your local feed</Text>
        <Seg options={TABS} value={tab} onChange={setTab} />
      </View>

      {posts.isError ? (
        <Card flat style={styles.notice}>
          <Text style={styles.noticeText}>Couldn&rsquo;t load your feed just now.</Text>
        </Card>
      ) : loading ? (
        <View style={styles.column}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={styles.cardSkeleton} />
          ))}
        </View>
      ) : tab === "following" && !signedIn ? (
        <FollowingNudge />
      ) : items.length === 0 && tab === "foryou" ? (
        <View style={styles.column}>
          <PioneerBanner place={place} />
          {(globalPosts.data ?? []).length > 0 ? (
            <>
              <Divider label="Meanwhile, across Roam" />
              {((globalPosts.data ?? []) as FeedPost[]).map((p) => (
                <PostFeedCard key={`global-${p.id}`} post={p} />
              ))}
            </>
          ) : null}
        </View>
      ) : items.length === 0 ? (
        <Card flat style={styles.notice}>
          <Text style={styles.noticeText}>
            {tab === "following"
              ? "No posts from venues you follow yet — follow a few and their updates will land here."
              : `Nothing moving in ${place.name} just yet — check back soon.`}
          </Text>
        </Card>
      ) : (
        <View style={styles.column}>
          {items.map((it) => (
            <View key={it.key}>{it.node}</View>
          ))}
          {/* A short feed otherwise just stops into blank space; this closes the column. */}
          <Text style={styles.caughtUp}>You&rsquo;re all caught up</Text>
        </View>
      )}
    </View>
  );
}

/** The signed-out state of the Following tab. */
function FollowingNudge() {
  const prompt = useAuthPrompt();
  return (
    <Card style={styles.notice}>
      <Text style={styles.nudgeText}>{FOLLOWING_NUDGE}</Text>
      <View style={styles.nudgeCta}>
        <Button variant="pri" size="sm" onPress={() => prompt(FOLLOWING_NUDGE)}>
          Sign in
        </Button>
      </View>
    </Card>
  );
}

/**
 * PioneerBanner — shown on "For you" when a town has no local content yet. Rather than an
 * apologetic "nothing here", it reframes the empty area as a frontier: whoever posts first
 * sets the tone for everyone after them.
 */
function PioneerBanner({ place }: { place: Place }) {
  return (
    <Card style={styles.pioneer}>
      <View style={styles.pioneerKickerRow}>
        <View style={styles.pioneerGlyph}>
          <Icon name="sparkle" size={15} color={color.card} />
        </View>
        <Text style={styles.pioneerKicker}>You&rsquo;re early here</Text>
      </View>
      <Text style={styles.pioneerTitle}>Be the first in {place.name}</Text>
      <Text style={styles.pioneerBody}>
        No one&rsquo;s shared anything in {place.name} yet — so whatever you post sets the tone. Be
        the one who puts your area on the map.
      </Text>
    </Card>
  );
}

/** A mono-labelled rule, web's "meanwhile" separator. */
function Divider({ label }: { label: string }) {
  return (
    <View style={styles.divider}>
      <View style={styles.dividerRule} />
      <Text style={styles.dividerLabel}>{label}</Text>
      <View style={styles.dividerRule} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: space[3], marginBottom: space[4] },
  // The h2 token at the feed heading's own tighter tracking (-.015em).
  title: { ...text.h2, letterSpacing: -0.36, color: color.ink },
  column: { gap: space[4] },
  cardSkeleton: { height: 150, borderRadius: 20, backgroundColor: color.paper2 },
  notice: { padding: space[5] },
  noticeText: { fontFamily: family.ui, fontSize: 14, lineHeight: 22, color: color.ink2 },
  nudgeText: { fontFamily: family.ui, fontSize: 14, lineHeight: 22, color: color.ink2 },
  nudgeCta: { marginTop: space[3], alignItems: "flex-start" },

  pioneer: { padding: space[5], backgroundColor: color.crimsonTint, borderColor: color.crimsonTint2 },
  pioneerKickerRow: { flexDirection: "row", alignItems: "center", gap: space[2], marginBottom: space[2] },
  pioneerGlyph: {
    width: 30,
    height: 30,
    borderRadius: 999,
    backgroundColor: color.crimson700,
    alignItems: "center",
    justifyContent: "center",
  },
  pioneerKicker: {
    fontFamily: family.monoBold,
    fontSize: 10.5,
    letterSpacing: 0.84,
    textTransform: "uppercase",
    color: color.crimson700,
  },
  pioneerTitle: {
    fontFamily: family.display,
    fontSize: 22,
    lineHeight: 27,
    letterSpacing: -0.44,
    color: color.inkHi,
    marginBottom: 6,
  },
  pioneerBody: { fontFamily: family.ui, fontSize: 14.5, lineHeight: 23, color: color.ink2 },

  divider: { flexDirection: "row", alignItems: "center", gap: space[3] },
  dividerRule: { flex: 1, height: 1, backgroundColor: color.line },
  dividerLabel: {
    fontFamily: family.monoBold,
    fontSize: 10.5,
    letterSpacing: 0.84,
    textTransform: "uppercase",
    color: color.muted,
  },

  caughtUp: {
    fontFamily: family.monoBold,
    fontSize: 10.5,
    letterSpacing: 1.05,
    textTransform: "uppercase",
    color: color.muted,
    textAlign: "center",
    paddingTop: space[2],
  },
});
