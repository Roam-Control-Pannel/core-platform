/**
 * TownForum — the town's top Forum topics, ported from web's TownForum widget.
 *
 * Public read (townHall.listTopics, sorted `top`), so it fills whether or not anyone's
 * signed in. Each row is the topic's upvote tile beside its title and author — the same
 * anatomy as the feed's topic card, compressed to a rail row.
 */
import { View, Text, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { color, space } from "@roam/design/tokens";
import { Icon, family } from "../../../design";
import { useTrpc } from "../../../lib/TrpcProvider";
import { authorName, plural, type Author } from "../../../lib/format";
import type { Place } from "../../../lib/useCurrentPlace";
import { Section } from "../Section";
import { common } from "../common";

interface Topic {
  id: string;
  title: string;
  upvoteCount: number;
  replyCount: number;
  author: Author;
}

export function TownForum({ place }: { place: Place }) {
  const trpc = useTrpc();
  const q = useQuery({
    queryKey: ["townHall.listTopics", place.name, "top"],
    queryFn: () => trpc.townHall.listTopics.query({ localityName: place.name, sort: "top" }),
  });

  const topics = ((q.data?.topics ?? []) as Topic[]).slice(0, 4);

  return (
    <Section title="Town forum" icon="forum">
      {q.isError ? (
        <Text style={common.mutedNote}>Couldn&rsquo;t load the forum just now.</Text>
      ) : q.isPending ? (
        <View style={styles.skeletons}>
          <View style={common.rowSkeleton} />
          <View style={common.rowSkeleton} />
        </View>
      ) : topics.length === 0 ? (
        <Text style={common.mutedNote}>No topics in {place.name} yet.</Text>
      ) : (
        <View style={styles.list}>
          {topics.map((topic) => (
            <View key={topic.id} style={common.outlineCard}>
              <View style={styles.upvoteTile}>
                <Icon name="upvote" size={12} color={color.crimson700} />
                <Text style={styles.upvoteCount}>{topic.upvoteCount}</Text>
              </View>
              <View style={styles.main}>
                <Text style={styles.title} numberOfLines={2}>
                  {topic.title}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {authorName(topic.author)} · {plural(topic.replyCount, "reply", "replies")}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  skeletons: { gap: space[2] },
  list: { gap: space[2] },
  upvoteTile: {
    minWidth: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: color.crimsonTint,
    alignItems: "center",
    justifyContent: "center",
  },
  upvoteCount: { fontFamily: family.uiBold, fontSize: 14, color: color.crimson700 },
  main: { flex: 1, gap: 2 },
  title: { fontFamily: family.uiSemi, fontSize: 14, color: color.ink },
  meta: { fontFamily: family.ui, fontSize: 12, color: color.muted },
});
