/**
 * The two card shapes the local feed mixes, ported from PostFeedCard / TopicFeedCard in
 * web's HomeFeed.tsx.
 *
 *   PostFeedCard  — a business post: venue header, kind chip, title/body, media, actions.
 *   TopicFeedCard — a Forum topic: upvote tile, chip, title, body, reply count.
 *   WallPostCard  — a person's wall post: author header, body, media, actions.
 *
 * Both are presentation over data the caller already fetched; neither reads tRPC itself,
 * so the feed can arrange them in any order without them knowing about each other.
 */
import { View, Text, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { color, space } from "@roam/design/tokens";
import { Card, Pill, Icon, family } from "../../design";
import { authorName, initial, plural, timeAgo, type Author } from "../../lib/format";
import { common } from "./common";
import { PostLike } from "./PostLike";

export interface FeedPost {
  id: string;
  kind: string;
  title: string | null;
  body: string | null;
  media?: { type: "image"; url: string }[];
  publishedAt: string | null;
  venueId: string;
  venueName: string | null;
  venueLocality: string | null;
  likeCount?: number;
  commentCount?: number;
  viewerLiked?: boolean;
}

export interface FeedTopic {
  id: string;
  slug: string | null;
  locality: string;
  title: string;
  body: string;
  upvoteCount: number;
  replyCount: number;
  createdAt: string;
  lastActivityAt: string | null;
  author: Author;
}

export interface WallPost {
  id: string;
  authorId: string;
  body: string | null;
  media: { type: "image" | "video"; url: string }[];
  location: string | null;
  likeCount: number;
  commentCount: number;
  createdAt: string;
  author: Author;
  viewerLiked: boolean;
}

/** Post-kind chip copy, matching web's `homeFeed.kind.*`. */
const KIND_LABEL: Record<string, string> = { news: "News", offer: "Offer", event: "Event" };

export function PostFeedCard({ post }: { post: FeedPost }) {
  const venueName = post.venueName ?? "A local business";
  const meta = [post.venueLocality, timeAgo(post.publishedAt)].filter(Boolean).join(" · ");
  const image = post.media?.find((m) => m.type === "image");

  return (
    <Card style={styles.card}>
      {/* Venue header */}
      <View style={styles.venueRow}>
        <View style={[common.avatar, styles.venueAvatar]}>
          <Text style={[common.avatarText, styles.venueAvatarText]}>{initial(venueName)}</Text>
        </View>
        <View style={styles.venueMain}>
          <Text style={styles.venueName} numberOfLines={1}>
            {venueName}
          </Text>
          {meta ? <Text style={styles.venueMeta}>{meta}</Text> : null}
        </View>
        <Pill variant="ghost-crim" size="sm">
          {KIND_LABEL[post.kind] ?? "News"}
        </Pill>
      </View>

      {post.title ? <Text style={styles.postTitle}>{post.title}</Text> : null}
      {post.body ? (
        <Text style={styles.postBody} numberOfLines={3}>
          {post.body}
        </Text>
      ) : null}

      {image ? (
        <Image
          source={{ uri: image.url }}
          style={styles.media}
          contentFit="cover"
          transition={180}
          accessibilityIgnoresInvertColors
        />
      ) : null}

      {/* Action bar. Comments are a count for now — the thread screen is its own slice, so
          this reads as meta rather than a control that goes nowhere. */}
      <View style={styles.actions}>
        <PostLike
          postId={post.id}
          initialLiked={post.viewerLiked ?? false}
          initialCount={post.likeCount ?? 0}
        />
        <View style={styles.metaAction}>
          <Icon name="chat" size={15} color={color.muted} />
          <Text style={styles.metaActionLabel}>{post.commentCount ?? 0}</Text>
        </View>
      </View>
    </Card>
  );
}

export function TopicFeedCard({ topic }: { topic: FeedTopic }) {
  return (
    <Card style={styles.card}>
      <View style={styles.topicRow}>
        {/* Upvote tile — the count is the tile, as on web. */}
        <View style={styles.upvoteTile}>
          <Icon name="upvote" size={13} color={color.crimson700} />
          <Text style={styles.upvoteCount}>{topic.upvoteCount}</Text>
        </View>
        <View style={styles.topicMain}>
          <View style={styles.topicChipRow}>
            <Pill variant="ghost-crim" size="sm">
              The Forum
            </Pill>
            <Text style={styles.topicMeta} numberOfLines={1}>
              {authorName(topic.author)} asked · {timeAgo(topic.createdAt)}
            </Text>
          </View>
          <Text style={styles.topicTitle}>{topic.title}</Text>
          {topic.body ? (
            <Text style={styles.topicBody} numberOfLines={2}>
              {topic.body}
            </Text>
          ) : null}
          <View style={styles.topicReplies}>
            <Icon name="chat" size={14} color={color.muted} />
            <Text style={styles.topicRepliesLabel}>
              {plural(topic.replyCount, "reply", "replies")}
            </Text>
          </View>
        </View>
      </View>
    </Card>
  );
}

/**
 * WallPostCard — a post from the viewer or one of their friends. The people half of the
 * feed: no kind chip and no venue, just who wrote it, where they were, and when.
 */
export function WallPostCard({ post }: { post: WallPost }) {
  const name = authorName(post.author);
  const meta = [post.location, timeAgo(post.createdAt)].filter(Boolean).join(" · ");
  const image = post.media.find((m) => m.type === "image");

  return (
    <Card style={styles.card}>
      <View style={styles.venueRow}>
        <View style={[common.avatar, styles.venueAvatar]}>
          <Text style={[common.avatarText, styles.venueAvatarText]}>{initial(name)}</Text>
        </View>
        <View style={styles.venueMain}>
          <Text style={styles.venueName} numberOfLines={1}>
            {name}
          </Text>
          {meta ? <Text style={styles.venueMeta}>{meta}</Text> : null}
        </View>
      </View>

      {post.body ? (
        <Text style={styles.postBody} numberOfLines={6}>
          {post.body}
        </Text>
      ) : null}

      {image ? (
        <Image
          source={{ uri: image.url }}
          style={styles.media}
          contentFit="cover"
          transition={180}
          accessibilityIgnoresInvertColors
        />
      ) : null}

      <View style={styles.actions}>
        <PostLike
          postId={post.id}
          initialLiked={post.viewerLiked}
          initialCount={post.likeCount}
          source="wall"
        />
        <View style={styles.metaAction}>
          <Icon name="chat" size={15} color={color.muted} />
          <Text style={styles.metaActionLabel}>{post.commentCount}</Text>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { padding: space[4] },

  venueRow: { flexDirection: "row", alignItems: "center", gap: space[2], marginBottom: space[2] },
  venueAvatar: { width: 34, height: 34 },
  venueAvatarText: { fontSize: 14 },
  venueMain: { flex: 1 },
  venueName: { fontFamily: family.uiSemi, fontSize: 14, color: color.ink },
  venueMeta: { fontFamily: family.ui, fontSize: 11.5, color: color.muted, marginTop: 1 },

  postTitle: {
    fontFamily: family.display,
    fontSize: 17,
    lineHeight: 22,
    letterSpacing: -0.17,
    color: color.inkHi,
    marginBottom: 6,
  },
  postBody: { fontFamily: family.ui, fontSize: 14, lineHeight: 22, color: color.ink2 },
  media: {
    marginTop: space[3],
    width: "100%",
    aspectRatio: 16 / 10,
    borderRadius: 14,
    backgroundColor: color.paper2,
  },
  actions: { flexDirection: "row", alignItems: "center", gap: space[4], marginTop: space[3] },
  metaAction: { flexDirection: "row", alignItems: "center", gap: 6 },
  metaActionLabel: { fontFamily: family.uiSemi, fontSize: 13, color: color.muted },

  topicRow: { flexDirection: "row", alignItems: "flex-start", gap: space[3] },
  upvoteTile: {
    minWidth: 42,
    height: 46,
    borderRadius: 12,
    backgroundColor: color.crimsonTint,
    alignItems: "center",
    justifyContent: "center",
  },
  upvoteCount: { fontFamily: family.uiBold, fontSize: 15, color: color.crimson700 },
  topicMain: { flex: 1, gap: 5 },
  topicChipRow: { flexDirection: "row", alignItems: "center", gap: space[2] },
  topicMeta: { fontFamily: family.ui, fontSize: 12, color: color.muted, flexShrink: 1 },
  topicTitle: {
    fontFamily: family.display,
    fontSize: 16.5,
    lineHeight: 21,
    letterSpacing: -0.165,
    color: color.inkHi,
  },
  topicBody: { fontFamily: family.ui, fontSize: 13.5, lineHeight: 20, color: color.ink2 },
  topicReplies: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  topicRepliesLabel: { fontFamily: family.uiSemi, fontSize: 12.5, color: color.muted },
});
